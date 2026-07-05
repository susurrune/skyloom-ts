import { getBackgroundManager } from './bgproc';
import { getSecurity } from './security';

const STARTED_AT_MS = Date.now();
const VERSION = (() => {
  try { return String(require('../../package.json').version); }
  catch { return 'unknown'; }
})();

export interface ToolRuntimeStat {
  name: string;
  calls: number;
  failures: number;
  avgMs: number;
  cacheHits: number;
  breaker: string;
}

export interface RuntimeStatusContext {
  workspacePath: string;
  agentMap: Map<string, {
    getStatus(): Record<string, unknown>;
    getToolStats?(): ToolRuntimeStat[];
  }>;
  toolRegistry: { listNames(): string[] };
  mcpStatus?: string[];
}

export interface RuntimeStatusSnapshot {
  version: string;
  generatedAt: string;
  workspace: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    pid: number;
    uptimeSeconds: number;
  };
  agents: {
    summary: { total: number; busy: number; idle: number };
    items: Record<string, Record<string, unknown>>;
  };
  tools: {
    registered: number;
    calls: number;
    failures: number;
    cacheHits: number;
    openBreakers: string[];
  };
  background: { total: number; running: number };
  mcp: { connected: number; servers: string[] };
  security: ReturnType<ReturnType<typeof getSecurity>['getStats']>;
}

/** Build a sanitized runtime snapshot shared by Web, CLI and diagnostics. */
export function buildRuntimeStatus(context: RuntimeStatusContext): RuntimeStatusSnapshot {
  const agentItems: Record<string, Record<string, unknown>> = {};
  let idle = 0;
  let calls = 0;
  let failures = 0;
  let cacheHits = 0;
  const openBreakers: string[] = [];

  for (const [name, agent] of context.agentMap) {
    const status = agent.getStatus();
    agentItems[name] = status;
    if (status.state === 'idle') idle++;

    for (const stat of agent.getToolStats?.() ?? []) {
      calls += stat.calls;
      failures += stat.failures;
      cacheHits += stat.cacheHits;
      if (stat.breaker !== 'closed') openBreakers.push(`${name}:${stat.name}`);
    }
  }

  const jobs = getBackgroundManager().list();
  const mcpServers = [...(context.mcpStatus ?? [])];
  const totalAgents = context.agentMap.size;

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    workspace: context.workspacePath,
    runtime: {
      node: process.version,
      platform: process.platform,
      pid: process.pid,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - STARTED_AT_MS) / 1000)),
    },
    agents: {
      summary: { total: totalAgents, busy: totalAgents - idle, idle },
      items: agentItems,
    },
    tools: {
      registered: context.toolRegistry.listNames().length,
      calls,
      failures,
      cacheHits,
      openBreakers: [...new Set(openBreakers)].sort(),
    },
    background: {
      total: jobs.length,
      running: jobs.filter((job) => job.status === 'running').length,
    },
    mcp: { connected: mcpServers.length, servers: mcpServers },
    security: getSecurity().getStats(),
  };
}
