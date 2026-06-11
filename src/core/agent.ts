/**
 * Base agent class for all Skyloom agents.
 *
 * Provides the core LLM reasoning loop, tool execution, memory management,
 * skill activation, and inter-agent communication.
 */

import { Event, EventType, MessageBus } from './bus';
import { TASK_DONE_SENTINEL } from './constants';
import { LLMClient, type LLMResponse, type ToolCall } from './llm';
import { getLogger } from './logger';
import { Memory, Message } from './memory';
import { Skill, SkillRegistry } from './skill';
import { type ToolDefinition, ToolRegistry } from './tool';
import {
  parseToolArgs,
  extractFilePathsFromMessages,
  enrichResponseWithArtifacts,
  formatArgsParseError,
  suggestToolNames,
  toolStatusLabel,
  synthesizeDelegationSummary,
  parseExtractedFacts,
} from './agent_helpers';
import { selectRelevantTools } from './tool_router';
import { getModelInfo } from './catalog';
import { estimateTokens } from './estimate';
import { LoopGuard } from './agent/guard';
import { Tracer, type Trace } from './trace';

const log = getLogger('agent');

/** Tools whose success means the filesystem changed (triggers the verify loop). */
const WRITE_TOOL_RE = /^(write_|edit_|delete_|create_)|^run_bash$|^git_commit$/;

/** Tools with side effects, hidden from the model while in plan mode. */
const SIDE_EFFECT_TOOL_RE = /^(write_|edit_|delete_|create_|kill_|launch_|service_|browser_)|^run_bash$|^git_commit$|^open_path$|^delegate_to$/;

/** Default context budget per recorded tool result (chars; ~3k tokens). */
const TOOL_RESULT_LIMIT = 12000;

/**
 * Clamp an oversized tool result before it enters the context window:
 * keep head + tail, tell the model what was cut and how to fetch precisely.
 */
/** A short, single-line preview of tool arguments for trace spans. */
function argsPreview(args: Record<string, any> | null | undefined): string {
  if (!args) return '';
  try { return JSON.stringify(args).replace(/\s+/g, ' ').slice(0, 80); } catch { return ''; }
}

export function clampToolResult(s: string, limit: number = TOOL_RESULT_LIMIT): string {
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.floor(limit * 0.72));
  const tail = s.slice(-Math.floor(limit * 0.18));
  const cut = s.length - head.length - tail.length;
  return `${head}\n…[工具结果过长，中间省略 ${cut} 字符 — 需要该部分时用更精确的参数重新调用（read_file 的 offset/limit、grep 定位、缩小查询范围）]\n${tail}`;
}

// Domain model lives in ./agent/task — re-exported here so importers of
// '../core/agent' are unaffected by the Phase 3 split.
import { AgentState, TaskState, Task, TaskResult } from './agent/task';
export { AgentState, TaskState, Task, TaskResult };

// Re-export Message type from memory for convenience
export type { Message };

export class BaseAgent {
  name: string = '';
  displayName: string = '';
  emoji: string = '';
  specialty: string = '';
  systemPrompt: string = '';
  toolNames: string[] = [];
  skillNames: string[] = [];

  protected config: any; // SkyloomConfig type
  protected llm: LLMClient;
  protected bus: MessageBus;
  protected toolRegistry: ToolRegistry;
  protected skillRegistry: SkillRegistry;
  public state: AgentState = AgentState.IDLE;
  public memory: Memory;
  /** Per-agent run tracer: span tree of the current/recent turns (see /trace). */
  public tracer: Tracer = new Tracer();
  protected _tools: ToolDefinition[] = [];
  protected _skills: Skill[] = [];
  protected _activeSkills: Set<string> = new Set();
  protected _skillTools: Map<string, string[]> = new Map();
  protected _skillConfigOverrides: Map<string, Record<string, any>> = new Map();
  protected _baseSystemPrompt: string = '';
  protected _maxToolRounds: number = 20;
  protected _maxToolRoundsHardCap: number = 40;
  protected _userTurnsSinceExtract: number = 0;
  protected _pendingExtracts: Set<Promise<any>> = new Set();
  protected _pendingRequests: Map<string, { resolve: (value: string) => void; reject: (err: Error) => void }> = new Map();
  protected _bgTasks: Set<Promise<void>> = new Set();
  approvalCallback: ((toolName: string, args: Record<string, any>) => Promise<boolean>) | null = null;
  /** Plan mode: read-only tool set + plan-first instructions on each turn. */
  planMode: boolean = false;
  /** Set when this turn executed a tool that mutates the filesystem (verify trigger). */
  protected _turnWroteFiles: boolean = false;
  private _hooks: import('./hooks').Hooks | null = null;
  protected _turnLock: Promise<void> = Promise.resolve();
  private _turnLockCounter: number = 0;
  private _turnLockResolve: (() => void) | null = null;

  // Time-tag cache (shared across all instances, 30s TTL)
  private static _timeTag: string | null = null;
  private static _timeTagTs: number = 0.0;

  constructor(
    config: any,
    llm: LLMClient,
    bus: MessageBus,
    toolRegistry: ToolRegistry,
    skillRegistry?: SkillRegistry | null
  ) {
    this.config = config;
    this.llm = llm;
    this.bus = bus;
    this.toolRegistry = toolRegistry;
    this.skillRegistry = skillRegistry || new SkillRegistry();
    // Normalize the memory config — YAML uses snake_case (db_path/short_term_limit)
    // while Memory expects camelCase. Tolerate both so a preserved config block
    // doesn't break construction.
    const mc: any = (config as any).memory || {};
    this.memory = new Memory({
      dbPath: mc.dbPath || mc.db_path || '~/.skyloom',
      shortTermLimit: mc.shortTermLimit || mc.short_term_limit || 100,
      maxPersistedMessages: mc.maxPersistedMessages || mc.max_persisted_messages,
    }, this.name);
    this._maxToolRounds = 20;
  }

  // ── System prompt resolution ──

  protected resolveSystemPrompt(): string {
    // Custom persona loading
    try {
      const { loadPersona } = require('./profile');
      const custom = loadPersona(this.name);
      if (custom) return custom;
    } catch { /* ignore */ }

    const lang = (this.config as any).llm?.language || 'zh';
    if (lang === 'en' && (this as any).systemPromptEn) {
      return (this as any).systemPromptEn;
    }
    return this.systemPrompt;
  }

  protected injectWorkspaceInfo(prompt: string): string {
    try {
      const { resolveWorkspacePath, initWorkspace } = require('./workspace');
      const wsRoot = resolveWorkspacePath((this.config as any).workspace?.path || 'auto');
      initWorkspace(wsRoot);
      const lang = (this.config as any).llm?.language || 'zh';
      if (lang === 'en') {
        return prompt + `\n\n## Workspace\n\`${wsRoot}\` — write to \`files/\`, \`output/\`, \`temp/\`. Prefer workspace paths for all file ops.`;
      }
      return prompt + `\n\n## 工作空间\n\`${wsRoot}\` — 产物写到 \`files/\` / \`output/\` / \`temp/\`。文件操作优先用此路径。`;
    } catch {
      return prompt;
    }
  }

  /** Always return the live current time — never stale. */
  protected currentTimeTag(): string {
    const date = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const iso = date.toISOString();
    const local = date.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `Current time: ${iso.slice(0, 19).replace("T", " ")} UTC (${local} ${tz})`;
  }

  /** Inject live time — only once per memory, never duplicates. */
  protected injectCurrentTime(): void {
    const st = this.memory.shortTerm;
    // Find existing time tag and update it
    for (let i = st.length - 1; i >= 0; i--) {
      if (st[i].role === "system" && (st[i].content || "").startsWith("[Current time:")) {
        st[i].content = this.currentTimeTag(); return;
      }
    }
    // No time tag yet — append after the last permanent system prompt
    for (let i = st.length - 1; i >= 0; i--) {
      if (st[i].role === "system") {
        st.splice(i + 1, 0, { role: "system", content: this.currentTimeTag() });
        return;
      }
    }
    // No existing system messages → only inject if the agent has been initialized
    // (tests without system prompts should not get a time tag injected)
  }

  protected injectBehaviorRules(prompt: string): string {
    const lang = (this.config as any).llm?.language || 'zh';
    if (lang === 'en') {
      return prompt +
        `\n\n## Thinking Protocol\nBefore acting, briefly weigh: (1) **What** is the actual need? (2) **How** sure am I? If <80%, flag with [uncertain] and ask.\nIf stuck, admit it — propose a partial answer or ask the user. Never fabricate.\n\n## Behavior\n- Act, don't narrate. No "I will..." before tool calls.\n- Stay in scope. Do what's asked, then stop.\n- Batch independent tool calls in one response.\n- For tasks with 3+ steps, plan with todo_write first and update item status as you go.\n- Verify writes: read back, report verified state.\n- Call list_skills when the task needs specialized capabilities.`;
    }
    return prompt +
      `\n\n## 思考协议\n行动前快速判断：(1) 用户真实需求是什么？(2) 我有多大把握？低于80%标注 [不确定] 并主动询问。\n卡住时承认，给出部分答案或请求用户指导。绝不编造。\n\n## 行为守则\n- 直接行动,不预告。不说「我将要...」,直接调用工具\n- 不擅自扩大范围。用户要什么做什么,核心完成即止\n- 独立的工具调用一次发出,并行执行\n- 3 步以上的任务先用 todo_write 列任务清单,开工/完成时逐项更新状态\n- 写入后回读验证,汇报已验证状态而非仅尝试\n- 任务涉及专业能力时（PPT/Excel/PDF/网页设计/代码审查等），先调 list_skills 查看可用技能，再用 use_skill 激活`;
  }

  protected injectProgrammingWisdom(prompt: string): string {
    const lang = (this.config as any).llm?.language || 'zh';
    if (lang === 'en') {
      return prompt + `\n\n## Engineering\nTop-tier engineer: type-safe code, real error handling, debugging by root cause, reviewing for security & perf.`;
    }
    return prompt + `\n\n## 工程能力\n顶级工程师:类型安全、真实的错误处理、按根因调试、按安全与性能审查。你可以阅读和修改 Skyloom 自身源码。`;
  }

  /** Layered SKY.md / CLAUDE.md / AGENTS.md project memory (see core/skymd). */
  protected injectProjectMemory(prompt: string): string {
    try {
      const { loadProjectMemory } = require('./skymd');
      const mem = loadProjectMemory();
      if (!mem.text) return prompt;
      return prompt + `\n\n## 项目记忆 (SKY.md)\n用户与项目维护的约定，优先级高于你的通用习惯：\n\n${mem.text}`;
    } catch {
      return prompt;
    }
  }

  reinitLanguage(): void {
    this._baseSystemPrompt = '';
    this._baseSystemPrompt = this.resolveSystemPrompt();
    this._baseSystemPrompt = this.injectWorkspaceInfo(this._baseSystemPrompt);
    this._baseSystemPrompt = this.injectBehaviorRules(this._baseSystemPrompt);
    this._baseSystemPrompt = this.injectProgrammingWisdom(this._baseSystemPrompt);
    this._baseSystemPrompt = this.injectProjectMemory(this._baseSystemPrompt);
    this._baseSystemPrompt += '\n\n' + this.currentTimeTag();
    this.rebuildSystemPrompt();
  }

  /** Re-read SKY.md layers into the system prompt (after `#` quick memory / edits). */
  reloadProjectMemory(): void {
    this.reinitLanguage();
  }

  async init(): Promise<void> {
    await this.memory.initDb();

    // Always try to resume the last session (persistent memory across sky restarts)
    if (this.memory.getActiveSession() === null) {
      const resumed = await this.memory.resumeLatestSession();
      if (resumed === null) {
        await this.memory.createSession();
      }
    }

    this._baseSystemPrompt = this.resolveSystemPrompt();
    this._baseSystemPrompt = this.injectWorkspaceInfo(this._baseSystemPrompt);
    this._baseSystemPrompt = this.injectBehaviorRules(this._baseSystemPrompt);
    this._baseSystemPrompt = this.injectProgrammingWisdom(this._baseSystemPrompt);
    this._baseSystemPrompt = this.injectProjectMemory(this._baseSystemPrompt);
    this._baseSystemPrompt += '\n\n' + this.currentTimeTag();
    this.rebuildSystemPrompt();
    this._tools = this.toolRegistry.getTools();
    this.loadSkills();
    this.bus.subscribe(this.name, this.handleEvent.bind(this));
  }

  refreshTools(): void {
    this._tools = this.toolRegistry.getTools();
  }

  loadSkills(): void {
    this._skills = this.skillRegistry.getSkills();
    this.registerSkillTools();
  }

  registerSkillTools(): void {
    if (this.toolRegistry.get('use_skill')) return;

    const self = this;

    this.toolRegistry.register({
      name: 'list_skills',
      description: 'List all available skills with their names and descriptions. Use this first to discover what skills you can activate.',
      parameters: [],
      handler: async () => {
        // live change detection: re-scan user/project skill folders so a
        // SKILL.md edit or drop-in applies without restarting the session
        try {
          const { registerDynamicSkills } = require('../skills/loader');
          registerDynamicSkills(self.skillRegistry);
          self.loadSkills();
        } catch { /* live reload is best-effort */ }
        const skills = self.getAvailableSkills();
        if (!skills.length) return 'No skills available.';
        const maxName = Math.max(...skills.map(s => s.name.length), 1);
        const lines = skills.map(s => {
          const name = s.name.padEnd(maxName);
          const active = s.active ? ' ★' : '';
          return `  ${name} — ${s.description}${active}`;
        });
        return 'Available skills:\n' + lines.join('\n');
      },
    });

    this.toolRegistry.register({
      name: 'use_skill',
      description: 'Activate a named skill to gain specialized capabilities. Call list_skills first.',
      parameters: [{
        name: 'name',
        type: 'string',
        description: 'The name of the skill to activate',
        required: true,
      }],
      handler: async (kwargs: Record<string, any>) => {
        const name = kwargs.name as string;
        if (self.activateSkill(name)) {
          const skill = self._skills.find(s => s.name === name);
          const desc = skill?.description || '';
          return `✓ Skill '${name}' activated: ${desc}`;
        }
        return `✗ Skill '${name}' not found. Call list_skills to see available options.`;
      },
    });

    this.toolRegistry.register({
      name: 'extend_rounds',
      description: 'Extend the tool-call budget for the current turn.',
      parameters: [{
        name: 'n',
        type: 'number',
        description: 'Number of additional rounds to add (default 10)',
        required: false,
      }],
      handler: async (kwargs: Record<string, any>) => {
        const n = (kwargs.n as number) || 10;
        const old = this._maxToolRounds;
        this._maxToolRounds += n;
        return `✓ Tool-round limit extended by ${n} (was ${old}, now ${this._maxToolRounds}).`;
      },
    });

    // ── Self-evolve tool: analyze failures and suggest prompt improvements ──
    this.toolRegistry.register({
      name: 'self_evolve',
      description: 'Analyze recent failure patterns and suggest System Prompt improvements. Use this when you repeatedly make the same mistake.',
      parameters: [{
        name: 'reason',
        type: 'string',
        description: 'Why you want to evolve (e.g. "I keep searching too many times before answering")',
        required: false,
      }],
      handler: async (kwargs: Record<string, any>) => {
        try {
          const { queryExperiences, analyzeFailures, applyPromptDiff } = require('./evolve');
          const experiences = queryExperiences(kwargs.reason as string || "", 5);
          if (experiences.length === 0) return 'No relevant failure patterns found. Keep going!';
          const analysis = analyzeFailures(self.name, experiences, self.systemPrompt);
          if (!analysis.suggestedDiffs.length) return 'No prompt improvements suggested. Current prompt looks good.';
          const diffs = analysis.suggestedDiffs;
          let result = `Analyzed ${experiences.length} failure patterns. Suggested improvements:\n\n`;
          let applied = 0;
          for (const diff of diffs) {
            result += `- ${diff.reason}\n  → ${diff.after}\n\n`;
            if (applyPromptDiff(self, diff)) applied++;
          }
          result += `${applied}/${diffs.length} improvements applied. Agent will perform better next time.`;
          return result;
        } catch (e: any) { return `Evolve error: ${e.message || e}`; }
      },
    });
  }

  activateSkill(name: string): boolean {
    let skill = this._skills.find(s => s.name === name);
    if (!skill) {
      const globalSkill = this.skillRegistry.get(name);
      if (globalSkill) {
        this._skills.push(globalSkill);
        skill = globalSkill;
      }
    }
    if (!skill) return false;

    this._activeSkills.add(name);
    if (skill.handler) {
      const handlerTools = skill.handler(this, this.toolRegistry);
      if (handlerTools) {
        this._skillTools.set(name, handlerTools.map((t: any) => t.name));
      }
    }

    const overrides: Record<string, any> = {};
    if (skill.model) overrides.model = skill.model;
    if (skill.temperature != null) overrides.temperature = skill.temperature;
    if (skill.maxTokens != null) overrides.maxTokens = skill.maxTokens;
    if (Object.keys(overrides).length > 0) {
      this._skillConfigOverrides.set(name, overrides);
    }

    this.rebuildSystemPrompt();
    return true;
  }

  deactivateSkill(name: string): boolean {
    if (!this._activeSkills.has(name)) return false;
    this._activeSkills.delete(name);

    const toolNames = this._skillTools.get(name);
    if (toolNames) {
      for (const tn of toolNames) {
        this.toolRegistry.unregister(tn);
      }
      this._skillTools.delete(name);
    }
    this._skillConfigOverrides.delete(name);
    this.rebuildSystemPrompt();
    return true;
  }

  deactivateAllSkills(): void {
    for (const name of [...this._activeSkills]) {
      this.deactivateSkill(name);
    }
  }

  protected autoActivateSkills(message: string): string[] {
    if (!message) return [];
    const lowered = message.toLowerCase();
    const candidates = [...this._skills];
    for (const s of this.skillRegistry.getSkills()) {
      if (!candidates.find(c => c.name === s.name)) {
        candidates.push(s);
      }
    }

    const activated: string[] = [];
    for (const skill of candidates) {
      if (this._activeSkills.has(skill.name)) continue;
      if (!skill.triggers || !skill.triggers.length) continue;
      for (const trig of skill.triggers) {
        if (trig && lowered.includes(trig.toLowerCase())) {
          if (this.activateSkill(skill.name)) {
            activated.push(skill.name);
          }
          break;
        }
      }
    }
    return activated;
  }

  protected runtimeIdentityBlock(): string {
    const lang = (this.config as any).llm?.language || 'zh';
    let model = (this.config as any).llm?.defaultModel || 'gpt-4o';
    try {
      const agentCfg = (this.config as any).agents?.[this.name];
      if (agentCfg?.model) model = agentCfg.model;
    } catch { /* ignore */ }

    let userBlock = '';
    try {
      const { formatProfileForPrompt, formatMemoriesForPrompt } = require('./profile');
      userBlock = formatProfileForPrompt(lang);
      if (this.name === 'fair') userBlock += formatMemoriesForPrompt(lang);
    } catch { /* ignore */ }

    // Team context — all six agents and their roles
    const team = [
      ['fog','≋','雾 Fog','松烟墨','探索洞察 · 研究搜索'],
      ['rain','⸽','雨 Rain','石青','创造产出 · 代码写作'],
      ['frost','✱','霜 Frost','石绿','精炼品质 · 审查审计'],
      ['snow','❉','雪 Snow','铅白','架构规划 · 任务编排'],
      ['dew','∘','露 Dew','赭石','可靠守护 · 系统运维'],
      ['fair','☼','晴 Fair','朱砂','情感陪伴 · 知心对话'],
    ];
    const me = team.find(t => t[0] === this.name);
    const others = team.filter(t => t[0] !== this.name);

    if (lang === 'en') {
      const teamBlock = others.map(t => `- **${t[2]}** (${t[3]}): ${t[4]}`).join('\n');
      return `\n\n## Who You Are\nYou are **${me![2]}** — ${me![3]} (${me![4]}).\nYou live in **Skyloom 天空织机**, a weather-themed multi-agent framework.\nYou are powered by **${model}**.\n\n## Your Team\nThe other five agents are your colleagues:\n${teamBlock}\n\nAlways reply in English unless the user clearly writes in another language.` + userBlock;
    }
    const teamBlock = others.map(t => `- **${t[2]}**（${t[3]}）：${t[4]}`).join('\n');
    return `\n\n## 你是谁\n你是 **${me![2]}** — 矿物色 ${me![3]}，职责 ${me![4]}。\n你是「天空织机 Skyloom」的一员。Skyloom 是一个天气主题的多智能体协作框架，六位灵各司其职。\n当前由 **${model}** 驱动。\n\n## 你的同伴\n\n${teamBlock}\n\n默认始终用中文回复。` + userBlock;
  }

  protected rebuildSystemPrompt(): void {
    const identity = this.runtimeIdentityBlock();
    let prompt: string;

    if (this._activeSkills.size === 0) {
      prompt = this._baseSystemPrompt + identity;
    } else {
      const byName = new Map(this._skills.map(s => [s.name, s]));
      const skillPrompts: string[] = [];
      const lang = (this.config as any).llm?.language || 'zh';

      for (const name of [...this._activeSkills].sort()) {
        const s = byName.get(name);
        if (!s) continue;
        const parts: string[] = [];
        if (s.systemPrompt) parts.push(s.systemPrompt);
        if (s.bodyTruncated && s.sourcePath) {
          parts.push(lang === 'en'
            ? `[Lazy-loaded skill: full guide at \`${s.sourcePath}\`]`
            : `[此技能为懒加载：完整指南位于 \`${s.sourcePath}\`]`);
        }
        if (s.resourceDir) {
          parts.push(lang === 'en' ? `Resource directory: ${s.resourceDir}` : `资源目录: ${s.resourceDir}`);
        }
        skillPrompts.push(parts.join('\n\n'));
      }

      prompt = this._baseSystemPrompt;
      if (skillPrompts.length > 0) {
        prompt += '\n\n' + skillPrompts.join('\n\n');
      }
      prompt += identity;
    }

    // Remove ALL old system messages (including stale time tags), then add ONE fresh system prompt
    const filtered = this.memory.shortTerm.filter(m => m.role !== 'system');
    this.memory.shortTerm = filtered;
    this.memory.addMessage('system', prompt);
  }

  getActiveSkills(): string[] {
    return [...this._activeSkills];
  }

  getSkillConfigOverrides(): Record<string, any> {
    const merged: Record<string, any> = {};
    for (const overrides of this._skillConfigOverrides.values()) {
      Object.assign(merged, overrides);
    }
    return merged;
  }

  getAvailableSkills(): Array<{ name: string; description: string; active: boolean }> {
    return this._skills.map(s => ({
      name: s.name,
      description: s.description,
      active: this._activeSkills.has(s.name),
    }));
  }

  /**
   * Shared tool execution pipeline — parse, deduplicate, execute, record.
   *
   * Both chatStreamImpl (streaming) and llmLoop (batch) use the same tool
   * execution flow. Extracting it here eliminates ~80 lines of duplicated
   * Phase-A/B/C/D logic and ensures consistent behavior (dangerous-tool
   * approval, dedup, error handling) across both paths.
   *
   * @returns Array of { tc, result, success, toolName } for each tool call
   */
  protected async executeToolCalls(
    toolCalls: ToolCall[],
    options?: {
      dedupCacheable?: boolean;         // Enable dedup for cacheable tools
      onStatus?: (label: string) => void;
      suppressedTools?: Set<string>;     // Tools to mark as suppressed on error
      ephemeral?: boolean;               // Don't persist tool messages
    }
  ): Promise<Array<{ tc: ToolCall; result: string; success: boolean; toolName: string }>> {
    const suppressed = options?.suppressedTools;
    const ephemeral = options?.ephemeral ?? false;
    const onStatus = options?.onStatus;

    // Phase A: Parse all tool calls and resolve tools
    const parsed = toolCalls.map((tc) => {
      const toolName = tc.function.name;
      const rawArgs = tc.function.arguments;
      let toolArgs: Record<string, any> | null = null;
      let parseError: string | null = null;

      if (typeof rawArgs === 'string') {
        toolArgs = parseToolArgs(rawArgs);
        if (toolArgs === null) parseError = formatArgsParseError(toolName, rawArgs);
      } else {
        toolArgs = rawArgs;
      }

      this.bus.addEvent(new Event(EventType.TOOL_CALL, this.name, null, {
        tool: toolName, args: toolArgs || {},
      }));

      const tool = this.toolRegistry.get(toolName);
      const label = toolArgs ? toolStatusLabel(toolName, toolArgs) : `${toolName} (unparseable args)`;

      return { tc, toolName, toolArgs, tool, parseError, label, denied: false };
    });

    // Phase B: Approve dangerous tools (serial — may prompt user)
    const dangerousCalls = parsed.filter(p => p.tool && (p.tool as ToolDefinition).dangerous);
    if (dangerousCalls.length > 0) {
      for (const p of dangerousCalls) {
        if (!await this.checkToolApproval(p.toolName, p.toolArgs || {})) {
          p.denied = true;
        }
      }
    }

    // Build execution plan with optional dedup
    const execPlan: Array<{ idx: number; prep: typeof parsed[0]; isDuplicate: boolean }> = [];
    const seenDedupKeys = new Map<string, number>();

    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      // Dedup: only for cacheable, non-dangerous tools with identical args
      if (options?.dedupCacheable && p.toolArgs && p.tool && (p.tool as ToolDefinition).cacheable && !(p.tool as ToolDefinition).dangerous) {
        const key = `${p.toolName}:${JSON.stringify(p.toolArgs, Object.keys(p.toolArgs).sort())}`;
        if (seenDedupKeys.has(key)) {
          execPlan.push({ idx: i, prep: p, isDuplicate: true });
          continue;
        }
        seenDedupKeys.set(key, i);
      }
      execPlan.push({ idx: i, prep: p, isDuplicate: false });
    }

    // Phase C: Execute all unique tool calls in parallel
    const results = new Array<{ tc: ToolCall; result: string; success: boolean; toolName: string } | null>(parsed.length).fill(null);
    const uniqueExecutions = execPlan
      .filter(e => !e.isDuplicate)
      .map(async ({ idx, prep }) => {
        const p = prep;

        if (p.parseError) {
          return { idx, result: { tc: p.tc, result: p.parseError, success: false, toolName: p.toolName } };
        }
        if (p.denied) {
          return { idx, result: { tc: p.tc, result: `[denied] dangerous tool '${p.toolName}' blocked`, success: false, toolName: p.toolName } };
        }
        if (!p.tool) {
          if (suppressed) suppressed.add(p.toolName);
          const suggestions = suggestToolNames(p.toolName, this.toolRegistry);
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
          return { idx, result: { tc: p.tc, result: `Error: Tool '${p.toolName}' does not exist.${hint}`, success: false, toolName: p.toolName } };
        }

        if (onStatus) onStatus(p.label);
        await this.setState(AgentState.ACTING);

        // File checkpoint: snapshot the target before any mutating file tool
        // runs, so /rewind can restore the pre-turn state.
        try {
          const { getFileCheckpoints } = require('./file_checkpoint');
          const cp = getFileCheckpoints();
          const snapPath = cp.pathToSnapshot(p.toolName, p.toolArgs || {});
          if (snapPath) cp.snapshot(snapPath);
        } catch { /* checkpointing must never block execution */ }

        // pre_tool hooks are enforced policy: a non-zero exit blocks the call.
        const hooks = this.getHooks();
        if (hooks.preTool.length > 0) {
          try {
            const { runPreToolHooks } = require('./hooks');
            const pre = runPreToolHooks(hooks, p.toolName, p.toolArgs || {}, this.name);
            if (!pre.allowed) {
              return { idx, result: { tc: p.tc, result: `[blocked by pre_tool hook] ${pre.reason}`, success: false, toolName: p.toolName } };
            }
          } catch { /* hook machinery must never break tool execution */ }
        }

        // Leaf span: tools run concurrently, so they must not nest under each other.
        const span = this.tracer.startSpan(p.toolName, 'tool', { args: argsPreview(p.toolArgs) }, { leaf: true });
        try {
          const toolResult = await this.toolRegistry.execute(p.toolName, p.toolArgs || {});
          const resultStr = toolResult.result || toolResult.error || '(no output)';
          if (toolResult.success && WRITE_TOOL_RE.test(p.toolName)) this._turnWroteFiles = true;
          if (hooks.postTool.length > 0) {
            try {
              const { runPostToolHooks } = require('./hooks');
              runPostToolHooks(hooks, p.toolName, p.toolArgs || {}, this.name);
            } catch { /* best-effort */ }
          }
          span.end(toolResult.success ? 'ok' : 'error', toolResult.success ? undefined : { error: (toolResult.error || resultStr).slice(0, 120) });
          return { idx, result: { tc: p.tc, result: resultStr, success: toolResult.success, toolName: p.toolName } };
        } catch (e) {
          span.end('error', { error: String(e).slice(0, 120) });
          return { idx, result: { tc: p.tc, result: `Tool '${p.toolName}' execution failed: ${e}`, success: false, toolName: p.toolName } };
        }
      });

    const completed = await Promise.all(uniqueExecutions);
    for (const { idx, result } of completed) {
      results[idx] = result;
    }

    // Fill in dedup results from originals
    for (const e of execPlan) {
      if (e.isDuplicate && e.prep.toolArgs) {
        const dedupKey = `${e.prep.toolName}:${JSON.stringify(e.prep.toolArgs, Object.keys(e.prep.toolArgs).sort())}`;
        const originalIdx = seenDedupKeys.get(dedupKey);
        if (originalIdx !== undefined && results[originalIdx]) {
          results[e.idx] = { ...results[originalIdx]!, tc: e.prep.tc };
        }
      }
    }

    // Phase D: Record results to memory (clamped — one runaway read_file or
    // http_get must not flood the context window)
    const resultLimit = Number((this.config as any)?.llm?.tool_result_limit) || undefined;
    for (const r of results) {
      if (!r) continue;

      if (typeof r.result === 'string' && r.result.includes('[CircuitBreakerOpen]')) {
        if (suppressed) suppressed.add(r.toolName);
      }

      this.memory.addMessage('tool', clampToolResult(r.result, resultLimit), {
        name: r.toolName,
        toolCallId: r.tc.id,
        ephemeral,
      });
    }

    return results.filter(Boolean) as Array<{ tc: ToolCall; result: string; success: boolean; toolName: string }>;
  }

  async close(): Promise<void> {
    // Drain ALL in-flight background work BEFORE closing memory — both fact
    // extraction and background request handlers (delegate_to / agent requests).
    // Missing _bgTasks meant a request handler could still be writing to memory
    // as the DB closed, losing work or erroring on a closed database.
    const pending = [...this._pendingExtracts, ...this._bgTasks];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    await this.memory.close();
    this.bus.unsubscribe(this.name);
  }

  protected async setState(newState: AgentState): Promise<void> {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      const event = new Event(
        EventType.STATE_CHANGE,
        this.name,
        null,
        { old_state: oldState, new_state: newState }
      );
      this.bus.addEvent(event);
      await this.bus.notifyStateChange(event);
    }
  }

  async handleEvent(event: Event): Promise<void> {
    if (event.type === EventType.TASK_ASSIGNED && event.target === this.name) {
      const task = new Task(event.data as any);
      const result = await this.executeTask(task);
      await this.bus.publish(new Event(
        EventType.TASK_COMPLETED,
        this.name,
        event.source,
        { task_id: task.id, success: result.success, content: result.content }
      ));
    } else if (event.type === EventType.AGENT_REQUEST && event.target === this.name) {
      const p = this.handleRequest(event);
      this._bgTasks.add(p);
      p.then(() => this._bgTasks.delete(p)).catch(() => this._bgTasks.delete(p));
    } else if (event.type === EventType.AGENT_RESPONSE && event.target === this.name) {
      this.handleResponse(event);
    }
  }

  async chatOneshot(
    prompt: string,
    options?: { model?: string; temperature?: number; maxTokens?: number }
  ): Promise<string> {
    const overrides: Record<string, any> = {};
    if (options?.model) overrides.model = options.model;
    if (options?.temperature != null) overrides.temperature = options.temperature;
    if (options?.maxTokens != null) overrides.maxTokens = options.maxTokens;

    const messages = [{ role: 'system', content: `[${this.currentTimeTag()}]` }, { role: 'user', content: prompt }];
    const response = await this.llm.complete(
      messages,
      this.name,
      undefined,
      false,
      Object.keys(overrides).length > 0 ? overrides : undefined
    );
    return response.content;
  }

  async chat(
    message: string,
    onStatus?: ((status: string) => void) | null
  ): Promise<string> {
    return this.withTurnLock(() => this.chatImpl(message, onStatus));
  }

  protected async chatImpl(
    message: string,
    onStatus?: ((status: string) => void) | null
  ): Promise<string> {
    await this.setState(AgentState.THINKING);
    this.memory.addMessage('user', message);

    if (this.shouldAutoCompact()) {
      try { await this.compact(); } catch (e) { log.warn('auto_compact_failed', { error: String(e) }); }
    }

    try {
      if (onStatus) onStatus('thinking...');
      const response = await this.llmLoop({ onStatus });
      let content = response?.content || '(no response)';
      // Apply output filter for sensitive info
      try { const { filterOutput } = require('./filter'); const fr = filterOutput(content); if (fr.redacted) content = fr.clean; } catch {}
      this.memory.addMessage('assistant', content, {
        toolCalls: response?.toolCalls || [],
        reasoningContent: response?.reasoningContent,
      });
      await this.setState(AgentState.IDLE);
      this.maybeExtractFacts();
      return content;
    } catch (e) {
      await this.setState(AgentState.ERROR);
      this.popLastUserMessage();
      this.memory.pruneToolMessages();
      const errorMsg = `[${this.displayName}] Error: ${e}`;
      this.memory.addMessage('assistant', errorMsg);
      return errorMsg;
    }
  }

  async *chatStream(message: string, signal?: AbortSignal): AsyncGenerator<Record<string, any>> {
    const activatedNow = this.autoActivateSkills(message);
    const self = this;

    this.tracer.startTrace(message.replace(/\s+/g, ' ').slice(0, 80), this.name);
    try {
      for await (const ev of self.chatStreamImpl(message, activatedNow.length > 0 ? activatedNow : undefined, signal)) {
        yield ev;
      }
    } catch (err) {
      const st = this.memory.shortTerm;
      if (st.length > 0 && st[st.length - 1].role === 'user') {
        this.popLastUserMessage();
      }
      throw err;
    } finally {
      this.tracer.endTrace();
    }
  }

  /** The most recently completed (or in-progress) run trace. */
  getLastTrace(): Trace | null { return this.tracer.last(); }

  protected async *chatStreamImpl(
    message: string,
    autoActivated?: string[],
    signal?: AbortSignal
  ): AsyncGenerator<Record<string, any>> {
    await this.setState(AgentState.THINKING);
    // Plan mode: the tag travels with the message so the model plans instead
    // of acting, and the read-only tool filter below removes the temptation.
    const userMessage = this.planMode
      ? `[计划模式] 只读调研，不要执行任何修改。请输出一份编号的执行计划（涉及哪些文件、每步做什么、风险点），等待用户批准后再实施。\n\n${message}`
      : message;
    this.memory.addMessage('user', userMessage);
    try {
      require('./file_checkpoint').getFileCheckpoints().beginTurn(message);
    } catch { /* optional */ }
    let assistantStored = false;

    if (this.shouldAutoCompact()) {
      try { await this.compact(); } catch (e) { log.warn('auto_compact_failed', { error: String(e) }); }
    }

    const delegations: Array<[string, boolean]> = [];
    const suppressedTools = new Set<string>();

    if (autoActivated && autoActivated.length > 0) {
      suppressedTools.add('list_skills');
      this.memory.addMessage('system',
        '[Auto-activated skills: ' + autoActivated.join(', ') +
        '] These were chosen from your message\'s keywords. Do NOT call list_skills.'
      );
    }

    const guard = new LoopGuard();

    let toolNamesCache: string[] | null = null;
    let cacheKey: string | null = null;

    const resolveToolNames = (): string[] => {
      const key = JSON.stringify([[...suppressedTools].sort(), [...this._activeSkills].sort(), this.planMode]);
      if (toolNamesCache !== null && cacheKey === key) return toolNamesCache;
      let candidates = this.activeToolNames().filter(t => !suppressedTools.has(t));
      if (this.planMode) {
        candidates = candidates.filter(n => {
          if (SIDE_EFFECT_TOOL_RE.test(n)) return false;
          const t = this.toolRegistry.get(n);
          return !(t as any)?.dangerous;
        });
      }
      const must = new Set<string>();
      for (const s of this._skills) {
        if (this._activeSkills.has(s.name)) {
          for (const t of s.requiredTools) must.add(t);
        }
      }
      toolNamesCache = selectRelevantTools(this.toolRegistry, candidates, message, { mustInclude: must });
      cacheKey = key;
      return toolNamesCache;
    };

    try {
      let fullContent = '';
      let roundLimit = this._maxToolRounds;
      let roundCount = 0;

      while (true) {
        // User interrupt between rounds (Ctrl-C): stop before another LLM call.
        if (signal?.aborted) {
          if (!assistantStored && fullContent.trim()) {
            this.memory.addMessage('assistant', fullContent);
            assistantStored = true;
          } else if (!assistantStored) {
            this.popLastUserMessage();
          }
          await this.setState(AgentState.IDLE);
          yield { type: 'interrupted' };
          yield { type: 'done' };
          return;
        }
        if (roundCount >= roundLimit) {
          if (roundLimit >= this._maxToolRoundsHardCap) break;
          const extendBy = Math.min(15, this._maxToolRoundsHardCap - roundLimit);
          roundLimit += extendBy;
          this._maxToolRounds = roundLimit;
          this.memory.addMessage('system', `[Auto-extended tool-round limit by ${extendBy} to ${roundLimit}. Continue working.]`);
          continue;
        }
        roundCount++;
        roundLimit = Math.max(roundLimit, this._maxToolRounds);

        const messages = await this.messagesWithRecall();
        const toolNames = resolveToolNames();
        const toolCallsReceived: ToolCall[] = [];
        let streamingReasoning: string | undefined;
        let streamUsage: any = null;
        let roundContent = '';

        const llmSpan = this.tracer.startSpan('chat', 'llm', { model: this.resolveModelId(), round: roundCount });
        for await (const event of this.llm.streamWithTools(
          messages,
          this.name,
          toolNames.length > 0 ? toolNames : undefined,
          toolNames.length > 0 ? this.toolRegistry : undefined,
          Object.keys(this.getSkillConfigOverrides()).length > 0 ? this.getSkillConfigOverrides() : undefined,
          signal
        )) {
          if (event.type === 'content') {
            fullContent += event.text;
            roundContent += event.text;
            yield { type: 'content', text: event.text };
          } else if (event.type === 'tool_call' && event.toolCall) {
            toolCallsReceived.push(event.toolCall);
          } else if (event.type === 'error') {
            llmSpan.end('error', { error: String(event.text).slice(0, 120) });
            yield { type: 'content', text: `\n[Error: ${event.text}]` };
            if (!assistantStored) this.popLastUserMessage();
            await this.setState(AgentState.IDLE);
            return;
          } else if (event.type === 'reasoning' && event.text) {
            yield { type: 'reasoning', text: event.text };
          } else if (event.type === 'done') {
            streamUsage = event.usage;
            streamingReasoning = event.reasoningContent;
          }
        }
        llmSpan.end('ok', streamUsage ? {
          promptTokens: streamUsage.promptTokens ?? streamUsage.prompt_tokens,
          completionTokens: streamUsage.completionTokens ?? streamUsage.completion_tokens,
          cost: streamUsage.cost,
          toolCalls: toolCallsReceived.length,
        } : { toolCalls: toolCallsReceived.length });

        if (toolCallsReceived.length === 0) {
          let finalContent = roundContent;
          if (!fullContent.trim() && delegations.length > 0) {
            finalContent = synthesizeDelegationSummary(delegations);
          }
          this.memory.addMessage('assistant', finalContent, { reasoningContent: streamingReasoning });
          assistantStored = true;
          await this.setState(AgentState.IDLE);
          this.maybeExtractFacts();
          if (finalContent !== roundContent) yield { type: 'content', text: finalContent };
          yield { type: 'done' };
          return;
        }

        // Record assistant message with tool calls
        this.memory.addMessage('assistant', roundContent, {
          toolCalls: toolCallsReceived,
          reasoningContent: streamingReasoning,
        });
        assistantStored = true;

        if (streamUsage) {
          this.bus.addEvent(new Event(EventType.LLM_CALL, this.name, null, {
            model: '', usage: streamUsage,
          }));
        }

        // ── Execute all tools via shared pipeline ──
        // Emit tool_status events before execution
        for (const tc of toolCallsReceived) {
          const toolName = tc.function.name;
          const rawArgs = tc.function.arguments;
          const toolArgs = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
          const label = toolArgs ? toolStatusLabel(toolName, toolArgs) : `${toolName} (unparseable args)`;
          yield { type: 'tool_status', label, tool_name: toolName, args: toolArgs || {} };
        }

        const execResults = await this.executeToolCalls(toolCallsReceived, {
          dedupCacheable: true,
          suppressedTools,
        });

        // ── Record results with streaming ──
        let taskCompleted = false;
        for (const r of execResults) {
          if (r.toolName === 'task_done' && r.result === TASK_DONE_SENTINEL) {
            taskCompleted = true;
            const tc = toolCallsReceived.find(t => t.id === r.tc.id);
            const rawArgs = tc?.function?.arguments;
            const args = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
            const summary = (args?.summary as string) || '';
            const displayResult = summary ? `[Task completed: ${summary}]` : '[Task completed]';
            this.memory.addMessage('tool', displayResult, { name: r.toolName, toolCallId: r.tc.id });
            yield { type: 'tool_done', label: `task_done: ${summary}` || 'task_done', success: true, tool_name: 'task_done', result: displayResult };
            continue;
          }

          const tc = toolCallsReceived.find(t => t.id === r.tc.id);
          const rawArgs = tc?.function?.arguments;
          const args = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
          const label = args ? toolStatusLabel(r.toolName, args) : r.toolName;
          const truncated = (r.result || '').slice(0, 800);
          yield { type: 'tool_done', label, success: r.success, tool_name: r.toolName, result: truncated };
          if (r.toolName === 'delegate_to') {
            const target = (args?.agent as string) || '?';
            delegations.push([target, r.success]);
          }
        }

        if (taskCompleted) {
          if (!assistantStored) this.popLastUserMessage();
          await this.setState(AgentState.IDLE);
          yield { type: 'done' };
          return;
        }

        // ── Anti-loop guard (narration / tool-signature / stuck / search-storm) ──
        const decision = guard.observe(roundContent, toolCallsReceived, execResults);
        for (const hint of decision.hints) this.memory.addMessage('system', hint);
        if (decision.stop) {
          this.memory.addMessage('assistant', decision.stop.note);
          yield { type: 'content', text: decision.stop.contentLine };
          await this.setState(AgentState.IDLE);
          yield { type: 'done' };
          return;
        }
      }

      // Max iterations reached
      if (!assistantStored) this.popLastUserMessage();
      await this.setState(AgentState.IDLE);
      if (!fullContent.trim() && delegations.length > 0) {
        const synth = synthesizeDelegationSummary(delegations);
        this.memory.addMessage('assistant', synth);
        yield { type: 'content', text: synth };
      }
      yield { type: 'truncated', reason: `max tool rounds (${this._maxToolRounds}) reached` };
      yield { type: 'done' };
    } catch (e: any) {
      if (!assistantStored) this.popLastUserMessage();
      await this.setState(AgentState.ERROR);
      yield { type: 'content', text: `\n[Error: ${e.message || e}]` };
    } finally {
      this.memory.pruneToolMessages();
    }
  }

  protected popLastUserMessage(): void {
    for (let i = this.memory.shortTerm.length - 1; i >= 0; i--) {
      if (this.memory.shortTerm[i].role === 'user') {
        this.memory.shortTerm.splice(i, 1);
        break;
      }
    }
  }

  async compact(keepRecent: number = 12): Promise<string> {
    const systemMsgs = this.memory.shortTerm.filter(
      m => m.role === 'system' && !(m.content || '').startsWith('[Earlier-context digest')
    );
    const nonSystem = this.memory.shortTerm.filter(m => m.role !== 'system');

    if (nonSystem.length <= keepRecent + 4) return 'context is already compact';

    const toSummarize = nonSystem.slice(0, -keepRecent);
    const recent = nonSystem.slice(-keepRecent);

    // Extract directives
    const directiveKeywords = ['don\'t', 'do not', 'never', 'always', 'must', 'no ', '不要', '不准', '禁止', '必须', '一定', '记住'];
    const directives: string[] = [];
    for (const m of toSummarize) {
      if (m.role !== 'user') continue;
      const content = (m.content || '').trim();
      if (!content || content.length > 300) continue;
      if (directiveKeywords.some(k => content.toLowerCase().includes(k))) {
        directives.push(content);
      }
    }

    const text = toSummarize.map(m => {
      let content = (m.content || '').slice(0, 300);
      if (m.toolCalls) {
        const names = m.toolCalls.map((tc: any) => tc.function?.name).join(',');
        content += ` [tools: ${names}]`;
      }
      return `[${m.role}] ${content}`;
    }).join('\n');

    const resp = await this.llm.complete(
      [{ role: 'user', content: `Produce a TERSE factual digest. Bullet points only. Max 12 bullets. Preserve directives. \n\n${text}` }],
      this.name,
      undefined,
      false,
      Object.keys(this.getSkillConfigOverrides()).length > 0 ? this.getSkillConfigOverrides() : undefined
    );
    const summary = resp.content.trim().slice(0, 800);

    const digestParts = [
      `[Earlier-context digest — ${toSummarize.length} messages compressed. Reference only.]`,
      summary,
    ];
    if (directives.length > 0) {
      digestParts.push('Verbatim directives:');
      digestParts.push(...directives.slice(-8).map(d => `  - "${d}"`));
    }

    // Atomic update
    this.memory.shortTerm = [...systemMsgs];
    this.memory.addMessage('system', digestParts.join('\n'));
    for (const m of recent) {
      this.memory.shortTerm.push(m);
    }
    this.memory.pruneToolMessages();

    return `compressed ${toSummarize.length} messages (${summary.length} char digest)`;
  }

  /** Resolve the model id this agent runs on (mirrors LLMClient.getModel). */
  protected resolveModelId(): string {
    const c: any = this.config;
    return c.agents?.[this.name]?.model || c.default_model || c.llm?.default_model || c.llm?.defaultModel || 'gpt-4o';
  }

  /** The active model's real context window (tokens), from the catalog. */
  protected contextWindow(): number {
    const info = getModelInfo(this.resolveModelId());
    return info?.context && info.context > 0 ? info.context : 128000;
  }

  contextUsage(): Record<string, any> {
    const usage = this.memory.getContextWindowUsage();
    const max = this.contextWindow();
    return {
      estimatedTokens: usage.estimatedTokens,
      maxTokens: max,
      pct: Math.min(100, Math.round((usage.estimatedTokens / max) * 100)),
      messageCount: usage.messageCount,
      model: this.resolveModelId(),
    };
  }

  /** Per-role token breakdown for the /context command. */
  contextDetail(): Record<string, any> {
    const byRole: Record<string, { tokens: number; count: number }> = {};
    for (const m of this.memory.shortTerm) {
      const extra = (m as any).toolCalls ? JSON.stringify((m as any).toolCalls) : '';
      // CJK-aware estimate so the per-role breakdown matches the header total
      // (getContextWindowUsage weights Chinese characters ~2 tokens each).
      const tokens = estimateTokens((m.content || '') + extra);
      const slot = byRole[m.role] || (byRole[m.role] = { tokens: 0, count: 0 });
      slot.tokens += tokens;
      slot.count += 1;
    }
    return {
      ...this.contextUsage(),
      byRole,
      systemPromptTokens: estimateTokens(this._baseSystemPrompt),
      toolCount: this.activeToolNames().length,
      activeSkills: [...this._activeSkills],
    };
  }

  protected shouldAutoCompact(): boolean {
    const usage = this.memory.getContextWindowUsage();
    // Compact before hitting the real window — leave ~20% headroom for the reply.
    return usage.estimatedTokens > this.contextWindow() * 0.8;
  }

  protected activeToolNames(): string[] {
    const names = this.toolRegistry.listNames();
    const seen = new Set(names);
    let restriction: Set<string> | null = null;
    let anyUnrestricted = false;

    for (const skill of this._skills) {
      if (!this._activeSkills.has(skill.name)) continue;
      for (const tn of skill.requiredTools) {
        if (!seen.has(tn)) {
          names.push(tn);
          seen.add(tn);
        }
      }
      if (skill.allowedTools === null) {
        anyUnrestricted = true;
      } else {
        if (restriction === null) restriction = new Set();
        for (const t of skill.allowedTools) restriction.add(t);
      }
    }

    if (restriction !== null && !anyUnrestricted) {
      return names.filter(n => restriction!.has(n));
    }
    return names;
  }

  // ── Fact extraction ──

  private readonly EXTRACT_PROMPT = `你是一个事实抽取助手。从下面的对话中抽取**用户透露的稳定、可复用的事实**。

**应该抽取**：
- 工具/技术偏好（pkg_mgr=pnpm, editor=neovim, framework=FastAPI）
- 项目信息（project_lang=Python, project_name=skyloom）
- 长期目标（goal=build_url_shortener）
- 关键约束（os=Windows, python_version=3.13）

**输出格式**：纯 JSON 数组：
[{"key": "pkg_mgr", "value": "pnpm", "category": "user_pref"}]

对话：
{conversation}

输出：`;

  protected maybeExtractFacts(): void {
    if (process.env.WA_NO_EXTRACT === '1') return;
    const everyN = parseInt(process.env.WA_EXTRACT_EVERY_N || '20', 10);
    if (everyN <= 0) return;

    this._userTurnsSinceExtract++;
    if (this._userTurnsSinceExtract < everyN) return;
    this._userTurnsSinceExtract = 0;

    const p = this.extractFactsAsync();
    this._pendingExtracts.add(p);
    p.then(() => this._pendingExtracts.delete(p)).catch(() => this._pendingExtracts.delete(p));
  }

  private async extractFactsAsync(): Promise<number> {
    try {
      const recent = this.memory.shortTerm.slice(-20);
      const convoMsgs = recent.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content);
      if (convoMsgs.length < 4) return 0;
      const convoText = convoMsgs.map(m => `${m.role}: ${(m.content || '').slice(0, 500)}`).join('\n');
      const prompt = this.EXTRACT_PROMPT.replace('{conversation}', convoText);
      const response = await this.llm.complete([{ role: 'user', content: prompt }], `${this.name}_extract`, undefined);
      const facts = parseExtractedFacts(response.content);
      let written = 0;
      for (const f of facts) {
        const key = f.key;
        const value = f.value;
        const category = f.category || 'auto_extracted';
        if (typeof key !== 'string' || !key.trim() || value == null || value === '') continue;
        await this.memory.remember(key.trim(), value, String(category));
        written++;
      }
      if (written) log.info('auto_extracted_facts', { agent: this.name, count: written });
      return written;
    } catch (e) {
      log.warn('fact_extract_failed', { error: String(e) });
      return 0;
    }
  }

  protected async messagesWithRecall(): Promise<Record<string, any>[]> {
    // Inject live time before every LLM call so the agent always knows the current time
    this.injectCurrentTime();
    const messages = this.memory.getMessages();
    if (!messages || process.env.WA_NO_RECALL === '1') return messages;

    const revIdx = [...messages].reverse().findIndex(m => m.role === 'user');
    if (revIdx < 0) return messages; // no user message yet — nothing to recall against
    const lastUserIdx = messages.length - 1 - revIdx;

    const query = String(messages[lastUserIdx]?.content || '').slice(0, 200);
    const stripped = query.trim();
    if (stripped.length < 4) return messages;

    try {
      const facts = await this.memory.recallForInjection(query, 3);
      if (!facts.length) return messages;
      const block = Memory.formatFactsBlock(facts);
      if (!block) return messages;
      messages.splice(lastUserIdx, 0, { role: 'system', content: block });
    } catch { /* ignore */ }
    return messages;
  }

  protected async llmLoop(options?: {
    maxIterations?: number;
    onStatus?: ((status: string) => void) | null;
    ephemeral?: boolean;
  }): Promise<LLMResponse> {
    const maxIterations = options?.maxIterations ?? this._maxToolRounds;
    const ephemeral = options?.ephemeral ?? false;
    const onStatus = options?.onStatus ?? null;

    let response: LLMResponse = { content: '', toolCalls: [], model: '', usage: { promptTokens: 0, completionTokens: 0 }, cost: 0, truncated: false };
    const fullToolNames = this.activeToolNames();

    const lastUser = [...this.memory.shortTerm].reverse().find(m => m.role === 'user');
    const must = new Set<string>();
    for (const s of this._skills) {
      if (this._activeSkills.has(s.name)) {
        for (const t of s.requiredTools) must.add(t);
      }
    }
    const toolNames = selectRelevantTools(
      this.toolRegistry, fullToolNames, lastUser?.content || '', { mustInclude: must }
    );

    try {
      let limit = maxIterations;
      let rounds = 0;
      while (true) {
        if (rounds >= limit) {
          if (limit >= this._maxToolRoundsHardCap) break;
          const extendBy = Math.min(15, this._maxToolRoundsHardCap - limit);
          limit += extendBy;
          this._maxToolRounds = limit;
          this.memory.addMessage('system', `[Auto-extended limit by ${extendBy} to ${limit}.]`);
          continue;
        }
        rounds++;
        limit = Math.max(limit, this._maxToolRounds);

        const messages = await this.messagesWithRecall();
        if (onStatus) onStatus('thinking...');
        response = await this.llm.complete(
          messages, this.name,
          toolNames.length > 0 ? toolNames : undefined, false,
          Object.keys(this.getSkillConfigOverrides()).length > 0 ? this.getSkillConfigOverrides() : undefined
        );

        if (!response.toolCalls || response.toolCalls.length === 0) {
          return response;
        }

        this.bus.addEvent(new Event(EventType.LLM_CALL, this.name, null, {
          model: response.model, usage: response.usage,
        }));

        // Record assistant message
        this.memory.addMessage('assistant', response.content || '', {
          toolCalls: response.toolCalls,
          reasoningContent: response.reasoningContent,
          ephemeral,
        });

        // ── Execute all tools via shared pipeline ──
        await this.executeToolCalls(response.toolCalls, { onStatus: onStatus ?? undefined, ephemeral });
        await this.setState(AgentState.THINKING);
      }

      response.truncated = true;
      if (!response.content) {
        response.content = `[truncated] max tool rounds (${maxIterations}) reached.`;
      }
      return response;
    } catch (e) {
      this.memory.pruneToolMessages();
      throw e;
    }
  }

  async executeTask(
    task: Task,
    onStatus?: ((status: string) => void) | null
  ): Promise<TaskResult> {
    return this.withTurnLock(() => this.executeTaskImpl(task, onStatus));
  }

  private async executeTaskImpl(
    task: Task,
    onStatus?: ((status: string) => void) | null
  ): Promise<TaskResult> {
    await this.setState(AgentState.THINKING);
    task.transitionTo(TaskState.RUNNING);
    this.memory.setWorking('current_task', task);

    const prompt = `Complete this task NOW using your available tools. Then write the actual deliverable content in your final reply.\n\nTask: ${task.description}`;
    if (task.metadata) {
      const ctxData: Record<string, any> = {};
      for (const [k, v] of Object.entries(task.metadata)) {
        if (k !== 'goal') ctxData[k] = v;
      }
      if (Object.keys(ctxData).length > 0) {
        prompt + `\nContext: ${JSON.stringify(ctxData)}`;
      }
    }

    // Save and isolate short-term for task execution
    let savedShortTerm: Message[];
    try {
      // @ts-ignore - accessing private lock
      savedShortTerm = [...this.memory.shortTerm];
      this.memory.shortTerm = this.memory.shortTerm.filter(m => m.role === 'system');
    } catch {
      savedShortTerm = [...this.memory.shortTerm];
      this.memory.shortTerm = this.memory.shortTerm.filter(m => m.role === 'system');
    }

    this.memory.addMessage('user', prompt);
    const preLen = this.memory.shortTerm.length;
    this._turnWroteFiles = false;
    try {
      require('./file_checkpoint').getFileCheckpoints().beginTurn(`[task] ${task.description}`);
    } catch { /* optional */ }

    try {
      let response = await this.llmLoop({ onStatus, ephemeral: true });

      // ── 验证闭环: if this task touched the filesystem and verify commands
      // are configured (config.verify or SKY.md "## Verify"), run them and
      // feed failures back for a bounded number of fix rounds. ──
      try {
        const { resolveVerifyConfig, runVerify } = require('./verify');
        const vc = resolveVerifyConfig(this.config);
        if (vc.commands.length > 0 && this._turnWroteFiles) {
          for (let round = 0; round <= vc.maxFixRounds; round++) {
            if (onStatus) onStatus(`verify: ${vc.commands.length} 条命令`);
            const vr = runVerify(vc);
            if (vr.ok) {
              response.content += `\n\n[verify ✓ 全部通过]\n${vr.report}`;
              break;
            }
            if (round === vc.maxFixRounds) {
              response.content += `\n\n[verify ✗ 经 ${vc.maxFixRounds} 轮修复仍未通过]\n${vr.report.slice(0, 1500)}`;
              break;
            }
            if (onStatus) onStatus(`verify 失败 — 修复第 ${round + 1}/${vc.maxFixRounds} 轮`);
            log.warn('verify_failed_fixing', { agent: this.name, round: round + 1 });
            this.memory.addMessage('user',
              `[自动验证失败] 以下验证命令未通过。请定位根因并修复，确保它们全部通过：\n\n${vr.report}`);
            response = await this.llmLoop({ onStatus, ephemeral: true });
          }
        }
      } catch (e) {
        log.warn('verify_loop_error', { error: String(e) });
      }

      const filePaths = extractFilePathsFromMessages(this.memory.shortTerm.slice(preLen));
      const enriched = enrichResponseWithArtifacts(response.content, filePaths);
      this.memory.addMessage('assistant', enriched, { toolCalls: response.toolCalls, reasoningContent: response.reasoningContent });

      task.transitionTo(TaskState.COMPLETED);
      task.result = enriched;
      await this.setState(AgentState.IDLE);
      return new TaskResult(true, enriched);
    } catch (e) {
      task.transitionTo(TaskState.FAILED);
      task.result = String(e);
      this.memory.pruneToolMessages();
      await this.setState(AgentState.ERROR);
      return new TaskResult(false, String(e));
    } finally {
      // Restore chat history
      this.memory.shortTerm = savedShortTerm!;
    }
  }

  private _security: any = null;
  get security(): any { if (!this._security) { try { const { getSecurity } = require('./security'); this._security = getSecurity(); } catch { this._security = {}; } } return this._security; }

  protected getHooks(): import('./hooks').Hooks {
    if (!this._hooks) {
      try {
        const { loadHooks } = require('./hooks');
        this._hooks = loadHooks(this.config);
      } catch {
        this._hooks = { sessionStart: [], preTool: [], postTool: [] };
      }
    }
    return this._hooks!;
  }

  protected async checkToolApproval(toolName: string, toolArgs: Record<string, any>): Promise<boolean> {
    try {
      const sec = this.security;
      if (sec?.checkApproval) {
        const [approved, reason] = await sec.checkApproval(toolName, toolArgs, this.name);
        if (!approved) log.warn('tool_blocked', { tool: toolName, agent: this.name, reason });
        return approved;
      }
    } catch { /* fall through */ }
    const mode = (this.config as any).cli?.approvalMode || 'auto';
    if (mode === 'strict') return false;
    return true;
  }

  async requestHelp(targetAgent: string, description: string, timeout: number = 60): Promise<string> {
    const correlationId = Math.random().toString(36).slice(2, 14);

    const promise = new Promise<string>((resolve, reject) => {
      this._pendingRequests.set(correlationId, { resolve, reject });
    });

    await this.bus.publish(new Event(
      EventType.AGENT_REQUEST, this.name, targetAgent,
      { correlation_id: correlationId, description, source: this.name }
    ));

    try {
      const result = await Promise.race([
        promise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeout}s`)), timeout * 1000)
        ),
      ]);
      return result;
    } catch {
      this._pendingRequests.delete(correlationId);
      return `[${targetAgent} did not respond within ${timeout}s]`;
    }
  }

  protected async handleRequest(event: Event): Promise<void> {
    const description = event.data?.description || '';
    const correlationId = event.data?.correlation_id || '';
    const source = event.data?.source || '';
    if (!correlationId) return;

    const task = new Task({
      id: `req-${correlationId.slice(0, 8)}`,
      description,
      assignedTo: this.name,
    });

    try {
      const result = await this.executeTask(task);
      await this.bus.publish(new Event(
        EventType.AGENT_RESPONSE, this.name, source,
        { correlation_id: correlationId, content: result.content, success: result.success }
      ));
    } catch (e) {
      await this.bus.publish(new Event(
        EventType.AGENT_RESPONSE, this.name, source,
        { correlation_id: correlationId, content: `[error] ${e}`, success: false }
      ));
    }
  }

  protected handleResponse(event: Event): void {
    const correlationId = event.data?.correlation_id || '';
    if (!correlationId) return;
    const pending = this._pendingRequests.get(correlationId);
    if (pending) {
      this._pendingRequests.delete(correlationId);
      pending.resolve(event.data?.content || '');
    }
  }

  getStatus(): Record<string, any> {
    return {
      name: this.name,
      displayName: this.displayName,
      emoji: this.emoji,
      specialty: this.specialty,
      state: this.state,
      skills: this.getAvailableSkills(),
    };
  }

  // ── Turn lock ──

  private async withTurnLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this._turnLockCounter > 0) {
      await new Promise<void>(resolve => {
        const oldResolve = this._turnLockResolve;
        this._turnLockResolve = () => { oldResolve?.(); resolve(); };
      });
    }
    this._turnLockCounter++;
    try {
      return await fn();
    } finally {
      this._turnLockCounter--;
      if (this._turnLockResolve) {
        const r = this._turnLockResolve;
        this._turnLockResolve = null;
        r();
      }
    }
  }
}
