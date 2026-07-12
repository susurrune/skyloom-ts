import { describe, expect, it } from 'vitest';
import { buildRuntimeStatus } from '../src/core/status';

describe('runtime status snapshot', () => {
  it('aggregates agents, tools, MCP and safe runtime metadata', () => {
    const context: any = {
      workspacePath: 'D:\\workspace',
      agentMap: new Map([
        ['fog', {
          getStatus: () => ({ name: 'fog', state: 'idle', displayName: '雾' }),
          getToolStats: () => [
            { name: 'read_url', calls: 2, failures: 1, avgMs: 25, cacheHits: 1, breaker: 'open' },
          ],
        }],
        ['rain', {
          getStatus: () => ({ name: 'rain', state: 'acting', displayName: '雨' }),
          getToolStats: () => [
            { name: 'write_file', calls: 1, failures: 0, avgMs: 5, cacheHits: 0, breaker: 'closed' },
          ],
        }],
      ]),
      toolRegistry: { listNames: () => ['read_url', 'write_file', 'grep'] },
      mcpStatus: ['local: 3 tools'],
      mcp: {
        getHealthSnapshot: () => [{
          name: 'local',
          transport: 'stdio',
          target: 'node',
          tools: 3,
          connected: true,
          state: 'healthy',
          healthy: true,
          details: 'ok',
          lastCheckedAt: '2026-07-12T00:00:00.000Z',
          connectedAt: '2026-07-12T00:00:00.000Z',
        }],
      },
    };

    const status = buildRuntimeStatus(context);

    expect(status.version).toBe('1.26.0');
    expect(status.workspace).toBe('D:\\workspace');
    expect(status.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.agents.summary).toEqual({ total: 2, busy: 1, idle: 1 });
    expect(status.agents.items.fog.state).toBe('idle');
    expect(status.tools).toMatchObject({
      registered: 3,
      calls: 3,
      failures: 1,
      cacheHits: 1,
      openBreakers: ['fog:read_url'],
    });
    expect(status.mcp).toEqual({
      connected: 1,
      servers: ['local: 3 tools'],
      health: [{
        name: 'local',
        transport: 'stdio',
        target: 'node',
        tools: 3,
        connected: true,
        state: 'healthy',
        healthy: true,
        details: 'ok',
        lastCheckedAt: '2026-07-12T00:00:00.000Z',
        connectedAt: '2026-07-12T00:00:00.000Z',
      }],
    });
    expect(status.background.running).toBeGreaterThanOrEqual(0);
    expect(status.security.denied).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(status)).not.toMatch(/api[_-]?key|authorization|cookie/i);
  });
});
