import { describe, expect, it, vi } from 'vitest';
import { orchestrateTask } from '../src/core/factory';
import { TaskResult } from '../src/core/agent/task';
import { OrchestrationRunStore } from '../src/core/run_store';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function agent(executeTask: (task: any, onStatus?: ((status: string) => void) | null, signal?: AbortSignal) => Promise<TaskResult>) {
  return { executeTask, chatOneshot: async () => '{"achieved":true,"missing":""}' } as any;
}

describe('enterprise orchestration execution', () => {
  function runStore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skyloom-orchestration-'));
    return { store: new OrchestrationRunStore(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it('executes a built-in pipeline as hydrated domain tasks', async () => {
    const execute = vi.fn(async () => new TaskResult(true, 'x'.repeat(450)));
    const snow = agent(async () => new TaskResult(true, 'unused'));
    const runs = runStore();
    const [, results] = await orchestrateTask('请进行代码审查', new Map([
      ['snow', snow],
      ['frost', agent(execute)],
    ]), snow, { maxTaskRetries: 1, maxReplanRounds: 0, runStore: runs.store });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    runs.cleanup();
  });

  it('does not release downstream work after an upstream failure', async () => {
    const rainExecute = vi.fn(async () => new TaskResult(false, 'implementation failed'));
    const frostExecute = vi.fn(async () => new TaskResult(true, 'should not run'));
    const snow = agent(async () => new TaskResult(true, 'unused'));
    const runs = runStore();
    const [, results] = await orchestrateTask('实现并审查这个功能', new Map([
      ['snow', snow],
      ['rain', agent(rainExecute)],
      ['frost', agent(frostExecute)],
    ]), snow, { maxTaskRetries: 1, maxReplanRounds: 0, runStore: runs.store });

    expect(rainExecute).toHaveBeenCalledTimes(1);
    expect(frostExecute).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(results[1].content).toContain('dependency missing');
    runs.cleanup();
  });

  it('uses a fresh task state for a thin-result retry', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(new TaskResult(true, 'done'))
      .mockResolvedValueOnce(new TaskResult(true, 'actual deliverable '.repeat(30)));
    const snow = agent(async () => new TaskResult(true, 'unused'));
    const runs = runStore();
    const [, results] = await orchestrateTask('请进行代码审查', new Map([
      ['snow', snow],
      ['frost', agent(execute)],
    ]), snow, { maxTaskRetries: 2, maxReplanRounds: 0, runStore: runs.store });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).not.toBe(execute.mock.calls[1][0]);
    expect(results[0].success).toBe(true);
    runs.cleanup();
  });

  it('records a missing assigned agent as a failed task', async () => {
    const runs = runStore();
    const snow = {
      ...agent(async () => new TaskResult(true, 'unused')),
      orchestrate: async () => [{ id: 'unknown-1', description: 'specialized work', assignedTo: 'absent' }],
    } as any;
    let runId = '';

    const [, results] = await orchestrateTask('unmatched bespoke objective', new Map([['snow', snow]]), snow, {
      maxTaskRetries: 1,
      maxReplanRounds: 0,
      runStore: runs.store,
      onRun: run => { runId = run.runId; },
    });

    expect(results[0]).toMatchObject({ success: false, agent: 'absent' });
    expect(runs.store.load(runId).tasks[0].status).toBe('failed');
    runs.cleanup();
  });

  it('stops before downstream work after a cancellation request and preserves the run', async () => {
    const runs = runStore();
    const controller = new AbortController();
    const rainExecute = vi.fn(async () => new TaskResult(true, 'implementation artifact '.repeat(30)));
    const frostExecute = vi.fn(async () => new TaskResult(true, 'must not execute'));
    const snow = agent(async () => new TaskResult(true, 'unused'));
    let runId = '';

    const [, results, summary] = await orchestrateTask('实现并审查这个功能', new Map([
      ['snow', snow], ['rain', agent(rainExecute)], ['frost', agent(frostExecute)],
    ]), snow, {
      signal: controller.signal,
      maxTaskRetries: 1,
      maxReplanRounds: 0,
      runStore: runs.store,
      onRun: run => { runId = run.runId; },
      onTaskDone: async task => { if (task.assignedTo === 'rain') controller.abort(); },
    });

    expect(rainExecute).toHaveBeenCalledTimes(1);
    expect(frostExecute).not.toHaveBeenCalled();
    expect(results.some(result => result.content.includes('[cancelled]'))).toBe(true);
    expect(summary).toContain('[CANCELLED]');
    expect(runs.store.load(runId).status).toBe('cancelled');
    runs.cleanup();
  });

  it('propagates cancellation into an in-flight agent task', async () => {
    const runs = runStore();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn(async (_task: any, _status: unknown, signal?: AbortSignal) => {
      observedSignal = signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      return new TaskResult(true, 'should not complete');
    });
    const snow = agent(async () => new TaskResult(true, 'unused'));
    setTimeout(() => controller.abort(), 20);

    const startedAt = Date.now();
    const [, results, summary] = await orchestrateTask('请进行代码审查', new Map([
      ['snow', snow], ['frost', agent(execute)],
    ]), snow, {
      signal: controller.signal,
      maxTaskRetries: 1,
      maxReplanRounds: 0,
      runStore: runs.store,
    });

    expect(observedSignal).toBe(controller.signal);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(results[0].content).toContain('[cancelled]');
    expect(summary).toContain('[CANCELLED]');
    runs.cleanup();
  });

  it('resumes only failed nodes while preserving successful upstream work', async () => {
    const runs = runStore();
    const rainFirst = vi.fn(async () => new TaskResult(true, 'implementation artifact '.repeat(30)));
    const frostFirst = vi.fn(async () => new TaskResult(false, 'review service unavailable'));
    const snow = agent(async () => new TaskResult(true, 'unused'));
    let runId = '';
    await orchestrateTask('实现并审查这个功能', new Map([
      ['snow', snow], ['rain', agent(rainFirst)], ['frost', agent(frostFirst)],
    ]), snow, {
      maxTaskRetries: 1, maxReplanRounds: 0, runStore: runs.store,
      onRun: run => { runId = run.runId; },
    });

    const rainResume = vi.fn(async () => new TaskResult(true, 'must not rerun'));
    const frostResume = vi.fn(async () => new TaskResult(true, 'review completed '.repeat(30)));
    const [, resumed] = await orchestrateTask('实现并审查这个功能', new Map([
      ['snow', snow], ['rain', agent(rainResume)], ['frost', agent(frostResume)],
    ]), snow, {
      resume: true, runId, runStore: runs.store, maxTaskRetries: 1, maxReplanRounds: 0,
    });

    expect(rainResume).not.toHaveBeenCalled();
    expect(frostResume).toHaveBeenCalledTimes(1);
    expect(resumed.every(result => result.success)).toBe(true);
    expect(runs.store.load(runId).status).toBe('completed');
    runs.cleanup();
  });
});
