/**
 * Tests for tool subset routing.
 */
import { describe, it, expect } from 'vitest';
import { selectRelevantTools } from '../src/core/tool_router';
import { ToolRegistry } from '../src/core/tool';

function makeRegistry(toolSpecs: Array<[string, string]>): ToolRegistry {
  const r = new ToolRegistry();
  for (const [name, desc] of toolSpecs) {
    r.register({
      name,
      description: desc,
      parameters: [{ name: 'x', type: 'string', description: 'x' }],
      handler: async () => 'ok',
    });
  }
  return r;
}

describe('selectRelevantTools', () => {
  it('short query returns full set', () => {
    const r = makeRegistry(Array.from({ length: 20 }, (_, i) => [`tool_${i}`, `desc ${i}`]));
    const names = r.listNames();
    const selected = selectRelevantTools(r, names, 'ok', { topK: 5 });
    expect(new Set(selected)).toEqual(new Set(names));
  });

  it('small catalog returns full set', () => {
    const r = makeRegistry([['a', 'alpha'], ['b', 'beta']]);
    const names = r.listNames();
    const selected = selectRelevantTools(r, names, 'anything goes here', { topK: 12 });
    expect(new Set(selected)).toEqual(new Set(names));
  });

  it('caps at topK for large catalog', () => {
    const r = makeRegistry(Array.from({ length: 50 }, (_, i) => [`tool_${i}`, `desc ${i}`]));
    const names = r.listNames();
    const selected = selectRelevantTools(r, names, 'find weather data', { topK: 10 });
    expect(selected.length).toBeLessThanOrEqual(10);
  });

  it('relevant tools score higher', () => {
    const r = makeRegistry([
      ['read_file', 'read a file from disk'],
      ['write_file', 'write content to a file'],
      ['send_email', 'send an email message'],
      ['fetch_url', 'fetch a web URL'],
      ['query_db', 'query the database'],
    ]);
    const names = r.listNames();
    const selected = selectRelevantTools(r, names, 'read this config file', { topK: 3 });
    expect(selected).toContain('read_file');
  });

  it('mustInclude always present', () => {
    const r = makeRegistry(Array.from({ length: 20 }, (_, i) => [`random_${i}`, `unrelated tool ${i}`]));
    r.register({
      name: 'critical_tool',
      description: 'must always be available',
      parameters: [{ name: 'x', type: 'string', description: 'x' }],
      handler: async () => 'ok',
    });
    const names = r.listNames();
    const selected = selectRelevantTools(r, names, 'totally unrelated query', {
      topK: 3,
      mustInclude: new Set(['critical_tool']),
    });
    expect(selected).toContain('critical_tool');
  });
});
