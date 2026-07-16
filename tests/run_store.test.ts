import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OrchestrationRunStore, RunStoreError } from '../src/core/run_store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skyloom-runs-'));
  roots.push(root);
  let tick = 0;
  return new OrchestrationRunStore(root, () => new Date(1_700_000_000_000 + tick++));
}

describe('enterprise orchestration run store', () => {
  it('persists atomic snapshots and a verifiable append-only audit chain', () => {
    const runs = store();
    const run = runs.create('ship', [
      { id: '1', description: 'build', assignedTo: 'rain', dependsOn: [] },
      { id: '2', description: 'review', assignedTo: 'frost', dependsOn: ['1'] },
    ], 'run-1');
    runs.start(run);
    runs.taskStarted(run, '1');
    runs.taskFinished(run, '1', true, 'artifact', 'trace-1');
    const loaded = runs.load('run-1');

    expect(loaded.tasks[0]).toMatchObject({ status: 'completed', attempts: 1, result: 'artifact', traceIds: ['trace-1'] });
    expect(runs.events('run-1').map(event => event.type)).toEqual([
      'run.created', 'run.started', 'task.started', 'task.completed',
    ]);
    expect(runs.events('run-1').every((event, index, all) => index === 0 || event.previousHash === all[index - 1].hash)).toBe(true);
  });

  it('detects audit tampering before resume', () => {
    const runs = store();
    const run = runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-2');
    runs.start(run);
    const eventsFile = path.join(runs.rootDir, 'run-2', 'events.jsonl');
    fs.appendFileSync(eventsFile, '{"schemaVersion":1,"seq":99,"hash":"bad"}\n');
    expect(() => runs.load('run-2')).toThrow(RunStoreError);
  });

  it('recovers from a crash-truncated final audit record', () => {
    const runs = store();
    const run = runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-tail');
    runs.start(run);
    const eventsFile = path.join(runs.rootDir, 'run-tail', 'events.jsonl');
    fs.appendFileSync(eventsFile, '{"schemaVersion":1,"seq":3');

    const recovered = runs.load('run-tail');

    expect(recovered).toMatchObject({ runId: 'run-tail', revision: 2, status: 'running' });
    expect(runs.events('run-tail')).toHaveLength(2);

    runs.start(recovered);

    expect(runs.load('run-tail')).toMatchObject({ revision: 3, status: 'running' });
    expect(runs.events('run-tail').map(event => event.type)).toEqual([
      'run.created', 'run.started', 'run.started',
    ]);
    const repaired = fs.readFileSync(eventsFile, 'utf8');
    expect(repaired.endsWith('\n')).toBe(true);
    expect(repaired).not.toContain('{"schemaVersion":1,"seq":3{"schemaVersion"');
    const events = runs.events('run-tail');
    expect(events[2].previousHash).toBe(events[1].hash);
  });

  it('preserves a complete audit event that only lost its final newline', () => {
    const runs = store();
    const run = runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-newline');
    runs.start(run);
    const eventsFile = path.join(runs.rootDir, 'run-newline', 'events.jsonl');
    const content = fs.readFileSync(eventsFile);
    fs.writeFileSync(eventsFile, content.subarray(0, content.length - 1));

    const recovered = runs.load('run-newline');
    runs.start(recovered);

    expect(runs.events('run-newline')).toHaveLength(3);
    expect(fs.readFileSync(eventsFile, 'utf8').endsWith('\n')).toBe(true);
  });

  it('still rejects a malformed complete audit record', () => {
    const runs = store();
    runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-bad-tail');
    const eventsFile = path.join(runs.rootDir, 'run-bad-tail', 'events.jsonl');
    fs.appendFileSync(eventsFile, '{bad json}\n');

    expect(() => runs.load('run-bad-tail')).toThrowError(/audit chain/);
  });

  it('marks abandoned running tasks interrupted when a run restarts', () => {
    const runs = store();
    const run = runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-3');
    runs.start(run);
    runs.taskStarted(run, '1');
    const loaded = runs.load('run-3');
    runs.start(loaded);
    expect(loaded.tasks[0].status).toBe('interrupted');
  });

  it('replays committed audit events when the snapshot is stale', () => {
    const runs = store();
    const run = runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-replay');
    const snapshotFile = path.join(runs.rootDir, 'run-replay', 'run.json');
    const staleSnapshot = fs.readFileSync(snapshotFile, 'utf8');
    runs.start(run);
    runs.taskStarted(run, '1');
    runs.taskFinished(run, '1', true, 'durable result', 'trace-replay');

    fs.writeFileSync(snapshotFile, staleSnapshot, 'utf8');
    const recovered = runs.load('run-replay');

    expect(recovered.revision).toBe(4);
    expect(recovered.status).toBe('running');
    expect(recovered.tasks[0]).toMatchObject({
      status: 'completed', result: 'durable result', traceIds: ['trace-replay'],
    });
    expect(JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).revision).toBe(4);
  });

  it('reconstructs a run when the first snapshot replacement was interrupted', () => {
    const runs = store();
    runs.create('ship', [{ id: '1', description: 'build', assignedTo: 'rain' }], 'run-wal-only');
    fs.unlinkSync(path.join(runs.rootDir, 'run-wal-only', 'run.json'));

    const recovered = runs.load('run-wal-only');

    expect(recovered).toMatchObject({ runId: 'run-wal-only', goal: 'ship', status: 'planned', revision: 1 });
  });

  it('lists newest runs first and selects the latest recoverable run', () => {
    const runs = store();
    const first = runs.create('first', [{ id: '1', description: 'a', assignedTo: 'rain' }], 'run-a');
    runs.start(first);
    const second = runs.create('second', [{ id: '1', description: 'b', assignedTo: 'rain' }], 'run-b');
    runs.start(second);
    runs.taskStarted(second, '1');
    runs.taskFinished(second, '1', true, 'done');
    runs.finish(second, 'done');

    expect(runs.list().map(run => run.runId)).toEqual(['run-b', 'run-a']);
    expect(runs.latestRecoverable()?.runId).toBe('run-a');
  });

  it('prevents two processes from recovering the same run concurrently', () => {
    const runs = store();
    runs.create('ship', [{ id: '1', description: 'a', assignedTo: 'rain' }], 'run-lock');
    const release = runs.acquireLease('run-lock');
    expect(() => runs.acquireLease('run-lock')).toThrowError(/already active/);
    release();
    const releaseAgain = runs.acquireLease('run-lock');
    releaseAgain();
  });

  it('recovers a lease left behind by a crashed process', () => {
    const runs = store();
    runs.create('ship', [{ id: '1', description: 'a', assignedTo: 'rain' }], 'run-stale-lock');
    const lease = path.join(runs.rootDir, 'run-stale-lock', 'lease');
    fs.writeFileSync(lease, JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date(0).toISOString() }));

    const release = runs.acquireLease('run-stale-lock');

    expect(JSON.parse(fs.readFileSync(lease, 'utf8')).pid).toBe(process.pid);
    release();
  });
});
