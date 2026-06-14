/**
 * System factory — unified Agent creation and task orchestration.
 *
 * Avoids duplication between CLI and web entry points.
 */

import { BaseAgent, Task as AgentTask, TaskState } from './agent';
import { MessageBus } from './bus';
import { loadConfig } from './config';
import { LLMClient } from './llm';
import { getLogger } from './logger';
import { SkillRegistry } from './skill';
import { ToolRegistry } from './tool';

const log = getLogger('factory');

export class SystemContext {
  config: ReturnType<typeof loadConfig>;
  bus: MessageBus;
  llm: LLMClient;
  agentMap: Map<string, BaseAgent>;
  toolRegistry: ToolRegistry;
  workspacePath: string = '';
  mcp: any = null;
  mcpStatus: string[] = [];

  constructor(opts: {
    config: ReturnType<typeof loadConfig>;
    bus: MessageBus;
    llm: LLMClient;
    agentMap: Map<string, BaseAgent>;
    toolRegistry: ToolRegistry;
    workspacePath?: string;
    mcp?: any;
    mcpStatus?: string[];
  }) {
    this.config = opts.config;
    this.bus = opts.bus;
    this.llm = opts.llm;
    this.agentMap = opts.agentMap;
    this.toolRegistry = opts.toolRegistry;
    this.workspacePath = opts.workspacePath || '';
    this.mcp = opts.mcp || null;
    this.mcpStatus = opts.mcpStatus || [];
  }

  async initAll(): Promise<void> {
    if (this.mcp) {
      try {
        this.mcpStatus = await this.mcp.connectAll();
        if (this.mcpStatus.length > 0) {
          log.info('mcp_connected', { servers: this.mcpStatus.join(', ') });
        }
      } catch (e) {
        log.warn('mcp_connect_all_failed', { error: String(e) });
      }
    }
    for (const agent of this.agentMap.values()) {
      await agent.init();
    }
  }

  async closeAll(): Promise<void> {
    // Terminate any background shell jobs started this session.
    try {
      const { getBackgroundManager } = require('./bgproc');
      getBackgroundManager().killAll();
    } catch { /* best-effort */ }
    for (const agent of this.agentMap.values()) {
      await agent.close();
    }
    if (this.mcp) {
      try { await this.mcp.closeAll(); } catch (e) { log.warn('mcp_close_failed', { error: String(e) }); }
    }
  }
}

/**
 * Bootstrap the full system: config, bus, LLM, tools, skills, plugins, agents.
 */
export function createSystemContext(): SystemContext {
  const config = loadConfig();

  // session_start hooks — user-configured shell commands (see core/hooks)
  try {
    const { loadHooks, runSessionStartHooks } = require('./hooks');
    const hooks = loadHooks(config);
    if (hooks.sessionStart.length > 0) runSessionStartHooks(hooks);
  } catch { /* hooks must never block startup */ }

  let workspacePath = '';
  try {
    const { resolveWorkspacePath, initWorkspace } = require('./workspace');
    const wsRoot = resolveWorkspacePath((config as any).workspace?.path || 'auto');
    initWorkspace(wsRoot);
    workspacePath = wsRoot;
    log.info('workspace', { path: workspacePath });
  } catch { /* ignore */ }

  const bus = new MessageBus();

  // Shared registries
  const baseToolRegistry = new ToolRegistry();
  const baseSkillRegistry = new SkillRegistry();

  // Register builtin tools
  try {
    const { registerBuiltinTools } = require('../tools/builtin');
    registerBuiltinTools(baseToolRegistry);
  } catch (e) {
    log.warn('builtin_tools_not_available', { error: String(e) });
  }

  // Register all skills
  try {
    const { registerAllSkills } = require('../skills/loader');
    registerAllSkills(baseSkillRegistry);
  } catch (e) {
    log.warn('skills_not_available', { error: String(e) });
  }

  // Load plugins
  try {
    const { PluginLoader } = require('../plugins/loader');
    const pluginLoader = new PluginLoader(baseToolRegistry);
    const pluginConfig = (config as any).plugins;
    const pluginDirs = pluginConfig?.enabled ? (pluginConfig.directories || []) : [];
    pluginLoader.loadFromDirectories(pluginDirs);
  } catch (e) {
    log.warn('plugins_not_available', { error: String(e) });
  }

  // Configure MCP manager
  let mcpManager: any = null;
  try {
    const { MCPManager, loadPersistedServers, loadProjectMcpJson } = require('./mcp');
    mcpManager = new MCPManager(baseToolRegistry);
    const persisted = loadPersistedServers();
    const mcpServers = (config as any).mcp?.servers || [];
    const projectServers = loadProjectMcpJson(); // Claude Code 标准 .mcp.json
    // dedupe by name — project .mcp.json wins over runtime-added over config
    const byName = new Map<string, any>();
    for (const s of [...mcpServers, ...persisted, ...projectServers]) {
      if (s?.name) byName.set(s.name, s);
    }
    const allServers = [...byName.values()];
    if (allServers.length > 0) {
      mcpManager.configure(allServers);
    }
  } catch (e) {
    log.warn('mcp_not_available', { error: String(e) });
  }

  // Shared LLM client
  const llm = new LLMClient(config as any, baseToolRegistry);

  // Per-agent registries
  const agents = new Map<string, BaseAgent>();

  // Try to dynamically load agent classes
  const agentNames = ['fog', 'rain', 'frost', 'snow', 'dew', 'fair'];

  for (const name of agentNames) {
    const agentRegistry = new ToolRegistry();
    agentRegistry.merge(baseToolRegistry);
    const agentSkills = new SkillRegistry();
    agentSkills.merge(baseSkillRegistry);

    try {
      // Try dynamic import
      const clsName = name.charAt(0).toUpperCase() + name.slice(1) + 'Agent';
      // Use require for now since dynamic imports are async
      let AgentClass: any = null;
      try {
        const mod = require(`../agents/${name}`);
        AgentClass = mod[clsName];
      } catch {
        log.warn('agent_class_missing', { agent: name });
        continue;
      }

      if (!AgentClass) {
        log.warn('agent_class_not_found', { agent: name, class: clsName });
        continue;
      }

      const agent = new AgentClass(
        config,
        llm,
        bus,
        agentRegistry,
        agentSkills
      ) as BaseAgent;

      // Register delegate_to tool
      try {
        const { createDelegateTool } = require('../tools/delegate');
        agentRegistry.register(createDelegateTool(agents, agent));
      } catch (e) {
        log.warn('delegate_tool_not_available', { agent: name, error: String(e) });
      }

      // Register the spawn_agent tool — isolated-context subagents (Task tool).
      try {
        const { createSpawnAgentTool } = require('../tools/spawn');
        agentRegistry.register(createSpawnAgentTool({
          config,
          llm,
          bus,
          baseToolRegistry,
          baseSkillRegistry,
        }));
      } catch (e) {
        log.warn('spawn_tool_not_available', { agent: name, error: String(e) });
      }

      // Register model self-service tools (list_models / set_my_model)
      try {
        const { createModelTools } = require('../tools/model_tool');
        for (const t of createModelTools(name, config)) agentRegistry.register(t);
      } catch (e) {
        log.warn('model_tools_not_available', { agent: name, error: String(e) });
      }

      // Register the task-checklist tool (todo_write)
      try {
        const { createTodoTool } = require('../tools/todo');
        agentRegistry.register(createTodoTool(agent));
      } catch (e) {
        log.warn('todo_tool_not_available', { agent: name, error: String(e) });
      }

      agents.set(name, agent);
    } catch (e) {
      log.warn('agent_creation_failed', { agent: name, error: String(e) });
    }
  }

  // Bind agents to MCP
  if (mcpManager) {
    try {
      mcpManager.bindAgents(agents);
    } catch (e) {
      log.warn('mcp_bind_failed', { error: String(e) });
    }
  }

  return new SystemContext({
    config,
    bus,
    llm,
    agentMap: agents,
    toolRegistry: baseToolRegistry,
    workspacePath,
    mcp: mcpManager,
  });
}

// ── Task orchestration ──

export class TaskExecutionResult {
  id: string;
  agent: string;
  description: string;
  success: boolean;
  content: string;

  constructor(opts: {
    id: string;
    agent: string;
    description: string;
    success: boolean;
    content: string;
  }) {
    this.id = opts.id;
    this.agent = opts.agent;
    this.description = opts.description;
    this.success = opts.success;
    this.content = opts.content;
  }
}

// Placeholder phrases that mean the LLM gave up
const PLACEHOLDER_PATTERNS = [
  'done', 'ok', 'completed', 'task completed', 'task done', 'task finished',
  'finished', '已完成', '完成了', '好的', '好了', 'ok!',
];

const STATUS_REPORT_KEYWORDS = [
  '已完成', '完成了', '已成功', '已经完成', '工作已', '任务已',
  'task complete', 'task is complete', 'i have completed', "i've completed",
  'successfully completed', 'finished the', 'i finished',
  '已经写好', '已经写完', '已经做好', '写完了', '做完了',
];

const DELIVERABLE_MARKERS = [
  '```', 'http://', 'https://', '|', '## ', '###', '- [ ]', '1.', '/', '\\',
];

function isThinContent(content: string): boolean {
  if (!content) return true;
  const stripped = content.trim();
  if (!stripped) return true;
  const lowered = stripped.toLowerCase();
  if (lowered.startsWith('[truncated]') || lowered.startsWith('[error:')) return true;
  const bare = lowered.replace(/[.!?。！？\s]+$/, '').trim();
  if (PLACEHOLDER_PATTERNS.includes(bare)) return true;
  return (
    stripped.length <= 200 &&
    STATUS_REPORT_KEYWORDS.some(k => lowered.includes(k)) &&
    !DELIVERABLE_MARKERS.some(m => stripped.includes(m))
  );
}

const RESULT_FAILURE_MARKERS = [
  '[truncated]', '[stuck]', '[Error', 'Error:',
  '未能完成', '无法完成', '[cycle detected]', '[CircuitBreakerOpen]',
];

function looksObviouslyComplete(results: TaskExecutionResult[]): boolean {
  if (!results.length) return false;
  return results.every(r => {
    if (!r.success) return false;
    const body = (r.content || '').trim();
    if (body.length < 400) return false;
    return !RESULT_FAILURE_MARKERS.some(m => body.includes(m));
  });
}

async function executeWithRetry(
  agent: BaseAgent,
  aTask: any,
  maxAttempts: number,
  onStatus?: ((status: string) => void) | null
): Promise<any> {
  let lastResult: any = null;
  const originalDescription = aTask.description;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await agent.executeTask(aTask, onStatus);
      const content = (result.content || '').trim();
      const truncated = (result as any).truncated === true;
      const ok = result.success && !isThinContent(content);

      if (ok && !truncated) return result;
      lastResult = result;

      if (attempt < maxAttempts) {
        const reason = truncated
          ? 'previous attempt was truncated'
          : 'previous attempt was empty or a placeholder ack';
        aTask.description = `${originalDescription}\n\n[retry ${attempt + 1}/${maxAttempts}] ${reason}. You MUST produce the actual deliverable.`;
      }
    } catch (e) {
      lastResult = { success: false, content: `Attempt ${attempt} threw: ${e}` };
    }
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, Math.min(500 * Math.pow(2, attempt - 1), 2000)));
    }
  }

  aTask.description = originalDescription;
  return lastResult || { success: false, content: `All ${maxAttempts} attempts failed` };
}

async function executePending(
  pending: any[],
  agentMap: Map<string, BaseAgent>,
  results: TaskExecutionResult[],
  resultsById: Map<string, TaskExecutionResult>,
  fullContentsById: Map<string, string>,
  completed: Set<string>,
  options: {
    onTaskStart?: ((task: any) => Promise<void>) | null;
    onTaskDone?: ((task: any, result: TaskExecutionResult) => Promise<void>) | null;
    onToolStatus?: ((status: string) => void) | null;
    resultTruncate?: number | null;
    maxTaskRetries: number;
  }
): Promise<void> {
  while (pending.length > 0) {
    const ready = pending.filter(t => t.allDeps.every((dep: string) => completed.has(dep)));
    if (ready.length === 0) {
      for (const t of pending) {
        const missing = t.allDeps.filter((d: string) => !completed.has(d));
        t.transitionTo(TaskState.FAILED);
        const r = new TaskExecutionResult({
          id: t.id, agent: t.assignedTo || '',
          description: t.description, success: false,
          content: `[dependency missing] task ${t.id} requires ${missing.join(', ')} which never completed`,
        });
        results.push(r);
        resultsById.set(r.id, r);
        completed.add(r.id);
        if (options.onTaskDone) await options.onTaskDone(t, r);
      }
      pending.length = 0;
      return;
    }

    for (const t of ready) t.transitionTo(TaskState.RUNNING);

    const batchResults = await Promise.all(
      ready.map(async (t: any) => {
        const agent = agentMap.get(t.assignedTo);
        if (!agent) {
          return new TaskExecutionResult({
            id: t.id, agent: t.assignedTo || '',
            description: t.description, success: false,
            content: `Agent '${t.assignedTo}' not found`,
          });
        }
        if (options.onTaskStart) await options.onTaskStart(t);

        let description = t.description;
        const upstreamSections: string[] = [];
        const thinUpstreamIds: string[] = [];

        for (const depId of t.allDeps) {
          if (resultsById.has(depId)) {
            const parent = resultsById.get(depId)!;
            const fullContent = fullContentsById.get(depId) || parent.content || '';
            if (isThinContent(fullContent)) {
              thinUpstreamIds.push(parent.id);
              upstreamSections.push(
                `## 上游产出缺失 (task ${parent.id} · ${parent.agent})\n` +
                `⚠ 上游任务声称完成但未产出实际内容。\n` +
                `原始回复：\n${fullContent}`
              );
            } else {
              upstreamSections.push(
                `## 上游产出 (task ${parent.id} · ${parent.agent})\n${fullContent}`
              );
            }
          }
        }
        if (upstreamSections.length > 0) {
          description = `${t.description}\n\n${upstreamSections.join('\n\n')}`;
        }
        if (thinUpstreamIds.length > 0) {
          log.warn('thin_upstream', { task: t.id, thin_upstream: thinUpstreamIds });
        }

        const aTask = new AgentTask({
          id: t.id,
          description,
          assignedTo: t.assignedTo,
          parentId: t.parentId,
          metadata: t.metadata,
        });

        const result = await executeWithRetry(agent, aTask, options.maxTaskRetries, options.onToolStatus);

        if (result.success) t.transitionTo(TaskState.COMPLETED);
        else t.transitionTo(TaskState.FAILED);

        const full = result.content || '';
        fullContentsById.set(t.id, full);
        const tr = options.resultTruncate != null && full.length > options.resultTruncate
          ? full.slice(0, options.resultTruncate) : full;

        const r = new TaskExecutionResult({
          id: t.id, agent: t.assignedTo || '',
          description: t.description, success: result.success,
          content: tr,
        });
        if (options.onTaskDone) await options.onTaskDone(t, r);
        return r;
      })
    );

    for (const r of batchResults) {
      results.push(r);
      resultsById.set(r.id, r);
      completed.add(r.id);
    }
    for (const t of ready) {
      const idx = pending.indexOf(t);
      if (idx >= 0) pending.splice(idx, 1);
    }
  }
}

async function judgeGoalAchievement(
  snow: BaseAgent,
  goal: string,
  results: TaskExecutionResult[]
): Promise<[boolean, string]> {
  const bullets = results.map(r => {
    const status = r.success ? '成功' : '失败';
    const excerpt = (r.content || '').slice(0, 800);
    return `- [task ${r.id} · agent=${r.agent} · status=${status}] len=${(r.content || '').length}chars\n  ${excerpt}`;
  }).join('\n');

  const prompt = `你是一名极严格的项目验收员。验证 sub-task 真的产出了可验证的交付物。

## 验收规则（严格执行）

1. **「调研/搜集/查询」类**：必须列出具体对象名称和数据/特性/链接。
2. **「撰写/生成/写作」类**：必须包含实际的文本/代码/markdown。
3. **「审查/审计/对比」类**：必须列出具体问题点。
4. **核心交付物缺失绝不容忍**。

## 用户原目标
${goal}

## 子任务执行结果
${bullets}

严格按下列 JSON 格式输出（除 JSON 之外不要任何其他字符）：
{"achieved": true/false, "missing": "若未达成，逐项列出缺什么"}`;

  try {
    const raw = await snow.chatOneshot(prompt);
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/```/g, '').replace(/^json/i, '').trim();
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return [true, ''];
    const parsed = JSON.parse(text.slice(start, end + 1));
    return [!!parsed.achieved, (parsed.missing || '').trim()];
  } catch {
    return [true, ''];
  }
}

export async function orchestrateTask(
  goal: string,
  agentMap: Map<string, BaseAgent>,
  snow: BaseAgent | null = null,
  options?: {
    onTaskStart?: ((task: any) => Promise<void>) | null;
    onTaskDone?: ((task: any, result: TaskExecutionResult) => Promise<void>) | null;
    onPlanned?: ((tasks: any[]) => Promise<boolean | null>) | null;
    onToolStatus?: ((status: string) => void) | null;
    resultTruncate?: number | null;
    summaryPromptTemplate?: string;
    maxTaskRetries?: number;
    maxReplanRounds?: number;
    maxTotalTasks?: number;
    resume?: boolean;
  }
): Promise<[any[], TaskExecutionResult[], string]> {
  const snowAgent = snow || agentMap.get('snow') || null;
  if (!snowAgent) {
    return [[], [], 'Snow agent not available'];
  }

  const maxTaskRetries = options?.maxTaskRetries ?? 3;
  const maxReplanRounds = options?.maxReplanRounds ?? 1;
  const maxTotalTasks = options?.maxTotalTasks ?? 6;
  const resultTruncate = options?.resultTruncate ?? 500;

  // Try pipeline match first
  let tasks: any[];
  try {
    const { matchPipeline, buildTasksFromPipeline } = require('./pipelines');
    const matched = matchPipeline(goal);
    if (matched) {
      tasks = buildTasksFromPipeline(matched, goal);
    } else {
      tasks = await (snowAgent as any).orchestrate(goal);
    }
  } catch {
    tasks = await (snowAgent as any).orchestrate(goal);
  }

  if (!tasks || tasks.length === 0) {
    return [[], [], 'No tasks were planned'];
  }

  // Notify caller of the plan
  if (options?.onPlanned) {
    const proceed = await options.onPlanned(tasks);
    if (proceed === false) {
      return [tasks, [], '[CANCELLED] plan rejected before execution'];
    }
  }

  const completed = new Set<string>();
  const results: TaskExecutionResult[] = [];
  const resultsById = new Map<string, TaskExecutionResult>();
  const fullContentsById = new Map<string, string>();
  let pending = tasks.filter((t: any) => t.assignedTo && t.assignedTo !== 'snow');
  let replanRound = 0;

  // Cycle detection
  function hasCycle(t: any, path: Set<string>): boolean {
    if (path.has(t.id)) return true;
    path.add(t.id);
    for (const depId of t.allDeps || []) {
      const dep = tasks.find((x: any) => x.id === depId);
      if (dep && hasCycle(dep, new Set(path))) return true;
    }
    return false;
  }

  pending = pending.filter((t: any) => {
    if (hasCycle(t, new Set())) {
      results.push(new TaskExecutionResult({
        id: t.id, agent: t.assignedTo || '',
        description: t.description, success: false,
        content: `[cycle detected] task ${t.id} has circular dependency`,
      }));
      completed.add(t.id);
      return false;
    }
    return true;
  });

  while (true) {
    await executePending(pending, agentMap, results, resultsById, fullContentsById, completed, {
      onTaskStart: options?.onTaskStart || null,
      onTaskDone: options?.onTaskDone || null,
      onToolStatus: options?.onToolStatus || null,
      resultTruncate,
      maxTaskRetries,
    });
    pending = [];

    if (!results.length || replanRound >= maxReplanRounds) break;
    if (results.length === 1 && results[0].success) break;
    if (looksObviouslyComplete(results)) break;

    const [achieved, missing] = await judgeGoalAchievement(snowAgent, goal, results);
    if (achieved) break;

    replanRound++;
    try {
      const extraTasks = await (snowAgent as any).replanForMissing(goal, results, missing,
        new Set(tasks.map((t: any) => t.id)));
      if (!extraTasks || extraTasks.length === 0) break;
      if (tasks.length + extraTasks.length > maxTotalTasks) break;
      tasks.push(...extraTasks);
      if (options?.onPlanned) {
        const proceed = await options.onPlanned(tasks);
        if (proceed === false) break;
      }
      pending = extraTasks.filter((t: any) => t.assignedTo && t.assignedTo !== 'snow');
    } catch {
      break;
    }
  }

  // Generate summary
  let summary: string;
  if (!results.length) {
    summary = '没有需要执行的任务。';
  } else if (results.length === 1) {
    summary = results[0].content;
  } else {
    const tpl = options?.summaryPromptTemplate || '请汇总以下所有子任务的执行结果：\n\n';
    let summaryPrompt = tpl;
    for (const r of results) {
      const status = r.success ? '成功' : '失败';
      summaryPrompt += `### 任务 ${r.id} (${r.agent}) - ${status}\n${(r.content || '').slice(0, 300)}\n\n`;
    }
    summary = await snowAgent.chatOneshot(summaryPrompt);
  }

  // Check if we hit the replan budget without full completion
  if (replanRound >= maxReplanRounds && results.length > 1) {
    try {
      const [achieved, missing] = await judgeGoalAchievement(snowAgent, goal, results);
      if (!achieved && missing) {
        summary = `[INCOMPLETE] 经过 ${maxReplanRounds + 1} 轮规划仍未完全达成目标。\n剩余缺口：${missing}\n\n${summary}`;
      }
    } catch { /* ignore */ }
  }

  return [tasks, results, summary];
}
