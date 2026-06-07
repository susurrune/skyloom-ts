/**
 * MCP server — expose Skyloom agents as tools for external MCP clients.
 *
 * Runs over stdio (JSON-RPC 2.0). Any MCP-compatible client (Claude Desktop,
 * Zed, Continue, etc.) can connect and call Skyloom agents as tools.
 *
 * Registered tools:
 * - mcp_chat   — single-turn question to any agent
 * - mcp_task   — multi-agent orchestration
 * - list_agents — return available agent names + specialties
 */

import * as readline from 'readline';
import { createSystemContext, orchestrateTask } from './factory';

const MCP_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'skyloom', version: '1.4.0' };

const TOOL_DEFS = [
  {
    name: 'mcp_chat',
    description: 'Ask a Skyloom agent a question. Use fair for companionship, fog for research, rain for code, frost for review, dew for ops, snow for planning.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name: fog/rain/frost/snow/dew/fair (default: fair)' },
        message: { type: 'string', description: 'What to ask the agent' },
      },
      required: ['message'],
    },
  },
  {
    name: 'mcp_task',
    description: 'Run multi-agent orchestration. Snow plans, then agents collaborate. Use for complex multi-step goals.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal to accomplish' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'list_agents',
    description: 'List available Skyloom agents and their specialties.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export class MCPServer {
  private initialized = false;
  private ctx: any = null;
  private agents: Map<string, any> = new Map();

  async run(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        const resp = await this.handle(msg);
        if (resp !== null) {
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  private async handle(msg: Record<string, any>): Promise<Record<string, any> | null> {
    const mid = msg.id;
    const method = msg.method || '';
    const params = msg.params || {};

    // Notifications — no response
    if (method.startsWith('notifications/')) return null;

    try {
      let result: any;
      if (method === 'initialize') {
        result = await this.init();
      } else if (method === 'tools/list') {
        result = { tools: TOOL_DEFS };
      } else if (method === 'tools/call') {
        result = await this.toolsCall(params);
      } else {
        return { jsonrpc: '2.0', id: mid, error: { code: -32601, message: `unknown method: ${method}` } };
      }
      return { jsonrpc: '2.0', id: mid, result };
    } catch (e: any) {
      return { jsonrpc: '2.0', id: mid, error: { code: -32603, message: e.message || String(e) } };
    }
  }

  private async init(): Promise<Record<string, any>> {
    this.initialized = true;
    return { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
  }

  private async ensureCtx(): Promise<void> {
    if (!this.ctx) {
      this.ctx = createSystemContext();
      await this.ctx.initAll();
      this.agents = this.ctx.agentMap;
    }
  }

  private async toolsCall(params: Record<string, any>): Promise<Record<string, any>> {
    const name = params.name || '';
    const args = params.arguments || {};

    if (name === 'list_agents') return this.handleListAgents();
    if (name === 'mcp_chat') return this.handleChat(args);
    if (name === 'mcp_task') return this.handleTask(args);
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleListAgents(): Promise<Record<string, any>> {
    await this.ensureCtx();
    const lines = ['Available agents:'];
    for (const [name, agent] of this.agents) {
      lines.push(`- ${name} (${agent.displayName}): ${agent.specialty}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  private async handleChat(args: Record<string, any>): Promise<Record<string, any>> {
    const agentName = String(args.agent || 'fair').trim().toLowerCase();
    const message = String(args.message || '').trim();
    if (!message) {
      return { content: [{ type: 'text', text: 'Error: message is required' }], isError: true };
    }

    await this.ensureCtx();
    const agent = this.agents.get(agentName);
    if (!agent) {
      return { content: [{ type: 'text', text: `Unknown agent '${agentName}'. Available: ${[...this.agents.keys()].join(', ')}` }], isError: true };
    }

    try {
      const reply = await agent.chat(message);
      return { content: [{ type: 'text', text: reply }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Agent error: ${e.message || e}` }], isError: true };
    }
  }

  private async handleTask(args: Record<string, any>): Promise<Record<string, any>> {
    const goal = String(args.goal || '').trim();
    if (!goal) {
      return { content: [{ type: 'text', text: 'Error: goal is required' }], isError: true };
    }

    await this.ensureCtx();
    try {
      const [_tasks, results, summary] = await orchestrateTask(goal, this.agents);
      const ok = results.filter(r => r.success).length;
      const total = results.length;
      const contentLines = [`[${ok}/${total} tasks completed]`];
      for (const r of results) {
        contentLines.push(`## ${r.agent}: ${r.description}\n${r.content || '(no content)'}`);
      }
      if (summary) contentLines.push(`\n${summary}`);
      return { content: [{ type: 'text', text: contentLines.join('\n') }] };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Task error: ${e.message || e}` }], isError: true };
    }
  }
}

export async function startMCPServer(): Promise<void> {
  const server = new MCPServer();
  await server.run();
}
