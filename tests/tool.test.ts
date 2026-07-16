/**
 * Tests for tool system.
 */
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry, type ToolDefinition } from '../src/core/tool';

function makeTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    name: overrides.name,
    description: overrides.description ?? 'Test tool',
    parameters: overrides.parameters ?? [],
    handler: overrides.handler ?? vi.fn().mockResolvedValue('ok'),
    dangerous: overrides.dangerous,
    cacheable: overrides.cacheable,
    idempotent: overrides.idempotent,
    maxRetries: overrides.maxRetries,
    retryDelay: overrides.retryDelay,
    timeout: overrides.timeout,
    validateOutput: overrides.validateOutput,
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('register and get tool', () => {
    const tool = makeTool({ name: 'test_tool' });
    registry.register(tool);
    expect(registry.get('test_tool')).toBe(tool);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('list returns all tools', () => {
    registry.register(makeTool({ name: 'a', description: 'A' }));
    registry.register(makeTool({ name: 'b', description: 'B' }));
    expect(registry.list()).toHaveLength(2);
  });

  it('listNames returns all names', () => {
    registry.register(makeTool({ name: 'alpha', description: 'Alpha' }));
    registry.register(makeTool({ name: 'beta', description: 'Beta' }));
    const names = registry.listNames();
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('getTools returns all tools', () => {
    registry.register(makeTool({ name: 'x', description: 'X' }));
    expect(registry.getTools()).toHaveLength(1);
  });

  it('reregister overrides existing', () => {
    const t1 = makeTool({ name: 't', description: 'v1' });
    const t2 = makeTool({ name: 't', description: 'v2' });
    registry.register(t1);
    registry.register(t2);
    expect(registry.get('t')?.description).toBe('v2');
  });

  it('unregister removes tool', () => {
    registry.register(makeTool({ name: 'temp', description: 'Temp' }));
    expect(registry.get('temp')).toBeDefined();
    registry.unregister('temp');
    expect(registry.get('temp')).toBeUndefined();
  });

  it('has checks existence', () => {
    registry.register(makeTool({ name: 'exists' }));
    expect(registry.has('exists')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('merge copies tools', () => {
    const r2 = new ToolRegistry();
    r2.register(makeTool({ name: 't2', description: 'T2' }));
    registry.merge(r2);
    expect(registry.get('t2')).toBeDefined();
  });

  it('execute returns result from handler', async () => {
    const handler = vi.fn().mockResolvedValue('hello world');
    registry.register(makeTool({ name: 'greet', handler }));
    const result = await registry.execute('greet', { name: 'world' });
    expect(result.success).toBe(true);
    expect(result.result).toBe('hello world');
  });

  it('execute returns error for unknown tool', async () => {
    const result = await registry.execute('unknown', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('execute validates required parameters', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({
      name: 'needs_path',
      parameters: [{ name: 'path', type: 'string', description: 'File path', required: true }],
      handler,
    }));
    const result = await registry.execute('needs_path', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ToolRegistry · input validation + coercion', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); });

  function recordTool(name: string, parameters: any[]) {
    let received: any = null;
    registry.register(makeTool({
      name, parameters,
      handler: async (p: any) => { received = p; return 'ok'; },
    }));
    return () => received;
  }

  it('coerces a numeric string to a number for the handler', async () => {
    const got = recordTool('n', [{ name: 'x', type: 'number', description: 'x', required: true }]);
    await registry.execute('n', { x: '5' });
    expect(got()).toEqual({ x: 5 });
  });

  it('does not truncate floats (Number, not parseInt)', async () => {
    const got = recordTool('f', [{ name: 'x', type: 'number', description: 'x', required: true }]);
    await registry.execute('f', { x: '3.5' });
    expect(got()).toEqual({ x: 3.5 });
  });

  it('coerces boolean-like strings', async () => {
    const got = recordTool('b', [{ name: 'flag', type: 'boolean', description: 'f', required: true }]);
    await registry.execute('b', { flag: 'true' });
    expect(got()).toEqual({ flag: true });
  });

  it('parses a JSON-string object param', async () => {
    const got = recordTool('o', [{ name: 'cfg', type: 'object', description: 'c', required: true }]);
    await registry.execute('o', { cfg: '{"a":1}' });
    expect(got()).toEqual({ cfg: { a: 1 } });
  });

  it('rejects an uncoercible type and does not run the handler', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({
      name: 'num', parameters: [{ name: 'x', type: 'number', description: 'x', required: true }], handler,
    }));
    const res = await registry.execute('num', { x: 'not-a-number' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('expected number');
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces enum membership with a helpful message', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({
      name: 'pick',
      parameters: [{ name: 'mode', type: 'string', description: 'm', required: true, enum: ['fast', 'slow'] }],
      handler,
    }));
    const bad = await registry.execute('pick', { mode: 'turbo' });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('fast, slow');
    expect(handler).not.toHaveBeenCalled();

    const ok = await registry.execute('pick', { mode: 'fast' });
    expect(ok.success).toBe(true);
  });

  it('treats a present-but-null required param as missing', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({
      name: 'req', parameters: [{ name: 'p', type: 'string', description: 'p', required: true }], handler,
    }));
    const res = await registry.execute('req', { p: null });
    expect(res.success).toBe(false);
    expect(res.error).toContain('required');
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies declared defaults before invoking the handler', async () => {
    const got = recordTool('defaults', [
      { name: 'limit', type: 'number', description: 'limit', default: 25 },
    ]);
    const res = await registry.execute('defaults', {});
    expect(res.success).toBe(true);
    expect(got()).toEqual({ limit: 25 });
  });

  it('rejects non-finite numeric values', async () => {
    const handler = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({
      name: 'finite', parameters: [{ name: 'n', type: 'number', description: 'n', required: true }], handler,
    }));
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY, 'Infinity']) {
      const res = await registry.execute('finite', { n });
      expect(res.success).toBe(false);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ToolRegistry · cache isolation', () => {
  it('does not leak cached results between registries with the same tool name', async () => {
    const first = new ToolRegistry();
    const second = new ToolRegistry();
    first.register(makeTool({ name: 'identity', cacheable: true, handler: async () => 'agent-a' }));
    second.register(makeTool({ name: 'identity', cacheable: true, handler: async () => 'agent-b' }));

    expect((await first.execute('identity', {})).result).toBe('agent-a');
    expect((await second.execute('identity', {})).result).toBe('agent-b');
  });

  it('caches an empty-string result', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn().mockResolvedValue('');
    registry.register(makeTool({ name: 'empty', cacheable: true, handler }));
    await registry.execute('empty', {});
    await registry.execute('empty', {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached output when a tool is re-registered', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({ name: 'replaceable', cacheable: true, handler: async () => 'old' }));
    expect((await registry.execute('replaceable', {})).result).toBe('old');
    registry.register(makeTool({ name: 'replaceable', cacheable: true, handler: async () => 'new' }));
    expect((await registry.execute('replaceable', {})).result).toBe('new');
  });

  it('executes without caching when parameters cannot be serialized', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn().mockResolvedValue('ok');
    registry.register(makeTool({ name: 'circular', cacheable: true, handler }));
    const value: Record<string, unknown> = {};
    value.self = value;

    await expect(registry.execute('circular', { value })).resolves.toMatchObject({
      success: true,
      result: 'ok',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('ToolRegistry · retry safety', () => {
  it('does not retry a side-effecting tool unless retries are explicitly configured', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn().mockRejectedValue(new Error('write failed'));
    registry.register(makeTool({ name: 'write_once', handler }));
    const result = await registry.execute('write_once', {});
    expect(result.success).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps automatic retries for idempotent tools', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('ok');
    registry.register(makeTool({ name: 'read_retry', idempotent: true, retryDelay: 0, handler }));
    const result = await registry.execute('read_retry', {});
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([Number.NaN, -1, Number.NEGATIVE_INFINITY])(
    'falls back safely when maxRetries is invalid (%s)',
    async (maxRetries) => {
      const registry = new ToolRegistry();
      const handler = vi.fn().mockRejectedValue(new Error('failed once'));
      registry.register(makeTool({ name: `invalid_${String(maxRetries)}`, maxRetries, handler }));

      const result = await registry.execute(`invalid_${String(maxRetries)}`, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('failed once');
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );
});

describe('ToolRegistry · output validation', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); });

  it('fails the call when validateOutput rejects the result', async () => {
    registry.register(makeTool({
      name: 'guarded',
      maxRetries: 0,
      handler: async () => 'garbage',
      validateOutput: (r) => (r === 'garbage' ? 'looks like garbage' : null),
    }));
    const res = await registry.execute('guarded', {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('invalid tool output');
    expect(res.error).toContain('looks like garbage');
  });

  it('passes when validateOutput accepts the result', async () => {
    registry.register(makeTool({
      name: 'ok',
      handler: async () => 'fine',
      validateOutput: () => null,
    }));
    const res = await registry.execute('ok', {});
    expect(res.success).toBe(true);
    expect(res.result).toBe('fine');
  });

  it('retries a rejected output through the normal retry path', async () => {
    let n = 0;
    registry.register(makeTool({
      name: 'retryout',
      maxRetries: 1,
      retryDelay: 0,
      handler: async () => `v${++n}`,
      validateOutput: (r) => (r === 'v1' ? 'first is bad' : null),
    }));
    const res = await registry.execute('retryout', {});
    expect(res.success).toBe(true);
    expect(res.result).toBe('v2');
  });

  it('reports explicit error results as failures without retrying', async () => {
    const handler = vi.fn().mockResolvedValue('Error: file not found');
    registry.register(makeTool({ name: 'missing_file', idempotent: true, handler }));
    const res = await registry.execute('missing_file', {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('file not found');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('stableStringify', () => {
  it('produces an order-independent key for objects', async () => {
    const { stableStringify } = await import('../src/core/tool');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(stableStringify({ a: { x: 2, y: 1 } }));
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]'); // arrays keep order
  });
});

describe('execute · timeout timer is always cleared (no leak)', () => {
  it('clears the timeout timer when the handler resolves first', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'fast', handler: async () => 'done' }));
      const before = vi.getTimerCount();
      const res = await registry.execute('fast', {});
      expect(res.success).toBe(true);
      // The only timer execute() arms is the timeout guard; it must be cleared.
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still enforces the timeout when a handler hangs', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'slow',
      timeout: 20,
      maxRetries: 0,
      handler: () => new Promise<string>(() => { /* never resolves */ }),
    }));
    const res = await registry.execute('slow', {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('timeout');
  });

  it('aborts a cooperative handler when its timeout expires', async () => {
    const registry = new ToolRegistry();
    let observedAbort = false;
    registry.register(makeTool({
      name: 'abort_on_timeout',
      timeout: 20,
      maxRetries: 0,
      handler: ((_: Record<string, unknown>, context?: { signal: AbortSignal }) => new Promise<string>((resolve) => {
        if (!context) {
          setTimeout(() => resolve('completed without context'), 60);
          return;
        }
        context.signal.addEventListener('abort', () => {
          observedAbort = context.signal.aborted;
          resolve('handler stopped');
        }, { once: true });
      })) as any,
    }));

    const res = await registry.execute('abort_on_timeout', {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('timeout');
    expect(observedAbort).toBe(true);
  });

  it('cancels an in-flight handler when the caller aborts', async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    let observedAbort = false;
    registry.register(makeTool({
      name: 'abort_from_caller',
      timeout: 500,
      maxRetries: 0,
      handler: ((_: Record<string, unknown>, context?: { signal: AbortSignal }) => new Promise<string>((resolve) => {
        if (!context) {
          setTimeout(() => resolve('completed without context'), 60);
          return;
        }
        context.signal.addEventListener('abort', () => {
          observedAbort = context.signal.aborted;
          resolve('handler stopped');
        }, { once: true });
      })) as any,
    }));

    const pending = (registry.execute as any)('abort_from_caller', {}, { signal: controller.signal });
    controller.abort();
    const res = await pending;
    expect(res.success).toBe(false);
    expect(res.error).toContain('cancelled');
    expect(observedAbort).toBe(true);
  });

  it('does not count caller cancellation as a tool failure', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'cancel_without_breaking',
      maxRetries: 0,
      handler: async (params, context) => {
        if (params.finish) return 'ok';
        return new Promise<string>((resolve) => {
          context.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
        });
      },
    }));

    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const pending = registry.execute('cancel_without_breaking', {}, { signal: controller.signal });
      controller.abort();
      expect((await pending).error).toContain('cancelled');
    }

    expect(await registry.execute('cancel_without_breaking', { finish: true })).toMatchObject({ success: true, result: 'ok' });
    expect(registry.getStats()[0]).toMatchObject({ failures: 0, breaker: 'closed' });
  });
});
