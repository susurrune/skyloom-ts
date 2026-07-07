import { describe, expect, it } from 'vitest';
import {
  TurnInterrupt,
  isTopLevelCommand,
  parseHeadlessInvocation,
  readPipedInput,
  selectChatSurface,
} from '../src/cli/runtime';

describe('CLI runtime boundaries', () => {
  it('recognizes every registered top-level command before defaulting to chat', () => {
    for (const command of [
      'chat', 'task', 'web', 'mcp', 'gateway', 'channels', 'config',
      'init', 'apikey', 'version', 'doctor', 'help',
    ]) {
      expect(isTopLevelCommand(command), command).toBe(true);
    }
    expect(isTopLevelCommand('fog')).toBe(false);
    expect(isTopLevelCommand('review-this-project')).toBe(false);
  });

  it('uses the loom only for a sufficiently large interactive terminal', () => {
    expect(selectChatSurface({ stdinTTY: true, stdoutTTY: true, rows: 24, columns: 80 })).toBe('loom');
    expect(selectChatSurface({ stdinTTY: false, stdoutTTY: true, rows: 24, columns: 80 })).toBe('classic');
    expect(selectChatSurface({ stdinTTY: true, stdoutTTY: true, rows: 12, columns: 80 })).toBe('classic');
    expect(selectChatSurface({ stdinTTY: true, stdoutTTY: true, rows: 24, columns: 50 })).toBe('classic');
    expect(selectChatSurface({ stdinTTY: true, stdoutTTY: true, rows: 24, columns: 80, classic: true })).toBe('classic');
    expect(selectChatSurface({ stdinTTY: true, stdoutTTY: true, rows: 24, columns: 80, forceClassic: true })).toBe('classic');
  });

  it('parses and combines inline and piped headless prompts', () => {
    expect(parseHeadlessInvocation(['-p', 'review this', '--agent', 'frost', '--json'], 'extra context')).toEqual({
      prompt: 'review this\n\nextra context',
      agent: 'frost',
      json: true,
      streamJson: false,
    });
    expect(parseHeadlessInvocation(['--print'], 'from pipe')?.prompt).toBe('from pipe');
    expect(parseHeadlessInvocation(['chat'], '')).toBeNull();
  });

  it('rejects a headless invocation with no prompt or missing agent value', () => {
    expect(() => parseHeadlessInvocation(['-p'], '')).toThrow(/prompt/i);
    expect(() => parseHeadlessInvocation(['-p', 'hello', '--agent'], '')).toThrow(/agent/i);
  });

  it('reads non-TTY input and ignores interactive stdin', async () => {
    async function* chunks() { yield Buffer.from(' hello '); yield Buffer.from('world\n'); }
    expect(await readPipedInput(Object.assign(chunks(), { isTTY: false }))).toBe('hello world');
    expect(await readPipedInput(Object.assign(chunks(), { isTTY: true }))).toBe('');
  });

  it('aborts the active turn on first Ctrl-C and requests exit on second', () => {
    const turn = new TurnInterrupt();
    expect(turn.handle()).toBe('abort');
    expect(turn.signal.aborted).toBe(true);
    expect(turn.handle()).toBe('exit');
  });
});
