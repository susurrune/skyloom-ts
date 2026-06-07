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
    maxRetries: overrides.maxRetries,
    retryDelay: overrides.retryDelay,
    timeout: overrides.timeout,
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
