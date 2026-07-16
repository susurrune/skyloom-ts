import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeSlashCommand, type CommandRuntime } from '../src/cli/command_handlers';

const tempDirs: string[] = [];

function runtime(overrides: Partial<CommandRuntime> = {}): CommandRuntime {
  const sessions = [
    { id: 'abc12345-full', preview: 'first session', messageCount: 2 },
    { id: 'def67890-full', preview: 'second session', messageCount: 4 },
  ];
  const memory = {
    shortTerm: [{ role: 'user', content: 'hello' }],
    working: {},
    listSessions: vi.fn(async () => sessions),
    getActiveSession: vi.fn(() => sessions[0].id),
    clearShortTerm: vi.fn(async () => undefined),
    createSession: vi.fn(async () => 'new12345-full'),
    loadSession: vi.fn(async () => true),
  };
  const dir = mkdtempSync(join(tmpdir(), 'skyloom-command-'));
  tempDirs.push(dir);
  return {
    agent: { name: 'fog', displayName: '雾', state: 'idle', memory },
    config: { default_model: 'gpt-4o', agents: {} },
    sessionCache: { items: [] },
    modelConfigDir: dir,
    verifyRunner: vi.fn(() => ({ ok: true, report: '✓ npm test' })),
    verifyResolver: vi.fn(() => ({ commands: ['npm test'], maxFixRounds: 2, timeoutS: 30 })),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shared slash command handlers', () => {
  it('returns an agent status outcome without UI formatting', async () => {
    const result = await executeSlashCommand('/status', runtime());
    expect(result.handled).toBe(true);
    expect(result.lines.map((line) => line.text).join('\n')).toContain('雾 (fog)');
    expect(result.lines.map((line) => line.text).join('\n')).toContain('记忆 1 条');
  });

  it('lists sessions and caches them for index-based resume', async () => {
    const rt = runtime();
    const listed = await executeSlashCommand('/sessions', rt);
    expect(rt.sessionCache.items).toHaveLength(2);
    expect(listed.lines.some((line) => line.text.includes('first session'))).toBe(true);

    const resumed = await executeSlashCommand('/resume 2', rt);
    expect(rt.agent.memory.loadSession).toHaveBeenCalledWith('def67890-full');
    expect(resumed.lines.some((line) => line.text.includes('def67890'))).toBe(true);
  });

  it('starts a clean session and invokes the UI-specific reset hook', async () => {
    const afterNewSession = vi.fn();
    const rt = runtime({ afterNewSession });
    const result = await executeSlashCommand('/new', rt);
    expect(rt.agent.memory.clearShortTerm).toHaveBeenCalledOnce();
    expect(rt.agent.memory.createSession).toHaveBeenCalledOnce();
    expect(afterNewSession).toHaveBeenCalledOnce();
    expect(result.lines[0].text).toContain('new12345');
  });

  it('handles model inspection, switching, reset, and invalid ids consistently', async () => {
    const rt = runtime();
    expect((await executeSlashCommand('/model', rt)).lines[0].text).toContain('gpt-4o');

    const changed = await executeSlashCommand('/model gpt-4o-mini', rt);
    expect(changed.lines[0].tone).toBe('success');
    expect(rt.config.agents.fog.model).toBe('gpt-4o-mini');

    const reset = await executeSlashCommand('/model reset', rt);
    expect(reset.lines[0].tone).toBe('success');
    expect(rt.config.agents.fog.model).toBeUndefined();

    const invalid = await executeSlashCommand('/model definitely-not-a-model', rt);
    expect(invalid.lines[0].tone).toBe('warning');
  });

  it('renders and filters the shared model catalog', async () => {
    const all = await executeSlashCommand('/models', runtime());
    expect(all.handled).toBe(true);
    expect(all.lines.some((line) => line.text.includes('模型目录'))).toBe(true);
    expect(all.lines.some((line) => line.text.includes('gpt-4o'))).toBe(true);

    const filtered = await executeSlashCommand('/models openai', runtime());
    expect(filtered.lines.some((line) => line.text.includes('OpenAI'))).toBe(true);
    expect(filtered.lines.some((line) => line.text.includes('DeepSeek'))).toBe(false);
  });

  it('runs verification through injectable boundaries', async () => {
    const rt = runtime();
    const result = await executeSlashCommand('/verify', rt);
    expect(rt.verifyResolver).toHaveBeenCalledWith(rt.config);
    expect(rt.verifyRunner).toHaveBeenCalledOnce();
    expect(result.lines.some((line) => line.text === '✓ npm test')).toBe(true);
  });

  it('returns handled false for commands owned by other dispatchers', async () => {
    expect((await executeSlashCommand('/help', runtime())).handled).toBe(false);
  });
});
