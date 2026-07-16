/**
 * Base agent class for all Skyloom agents.
 *
 * Provides the core LLM reasoning loop, tool execution, memory management,
 * skill activation, and inter-agent communication.
 */

import { Event, EventType, MessageBus } from './bus';
import { LLMClient, type ToolCall } from './llm';
import { getLogger } from './logger';
import { Memory, Message } from './memory';
import { Skill, SkillRegistry } from './skill';
import { type ToolDefinition, ToolRegistry } from './tool';
import {
  extractFilePathsFromMessages,
  enrichResponseWithArtifacts,
  parseExtractedFacts,
} from './agent_helpers';
import { getModelInfo } from './catalog';
import { estimateTokens } from './estimate';
import { DelegationCoordinator } from './agent/delegation';
import { AgentLoop, type BatchLoopOptions } from './agent/loop';
import { AgentSessionController } from './agent/session';
import {
  ToolCallExecutor,
  type ToolCallExecutorOptions,
  type ToolExecutionResult,
} from './agent/tools';
import { Tracer, type Trace } from './trace';
import { resolveVerifyConfig, runVerify } from './verify';
import { getSecurity, type SecurityContext } from './security';

const log = getLogger('agent');

export { clampToolResult } from './agent/tools';

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
  /** Skills selected from the previous user message; replaced on the next turn. */
  protected _autoActiveSkills: Set<string> = new Set();
  protected _skillTools: Map<string, string[]> = new Map();
  protected _skillConfigOverrides: Map<string, Record<string, any>> = new Map();
  protected _baseSystemPrompt: string = '';
  /** @deprecated stopping is progress-based now; kept for back-compat only. */
  protected _maxToolRounds: number = 50;
  /** Last-resort backstop against runaway; not the normal stop path. */
  protected _maxToolRoundsHardCap: number = 1000;
  /** Stop after this many consecutive rounds with no progress (see chatStreamImpl). */
  protected _maxNoProgressRounds: number = 6;
  protected _userTurnsSinceExtract: number = 0;
  protected _pendingExtracts: Set<Promise<any>> = new Set();
  private _delegationCoordinator: DelegationCoordinator | null = null;
  approvalCallback: ((toolName: string, args: Record<string, any>) => Promise<boolean>) | null = null;
  /** Plan mode: read-only tool set + plan-first instructions on each turn. */
  planMode: boolean = false;
  /** Set when this turn executed a tool that mutates the filesystem (verify trigger). */
  protected _turnWroteFiles: boolean = false;
  private _hooks: import('./hooks').Hooks | null = null;
  private _sessionController: AgentSessionController | null = null;
  private _initPromise: Promise<void> | null = null;

  // Time-tag cache (shared across all instances, 30s TTL)
  private static _timeTag: string | null = null;
  private static _timeTagTs: number = 0.0;

  constructor(
    config: any,
    llm: LLMClient,
    bus: MessageBus,
    toolRegistry: ToolRegistry,
    skillRegistry?: SkillRegistry | null,
    runtimeName?: string,
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
    // Derived class fields are initialized only after super() returns, so
    // `this.name` is still empty here. Resolve the identity before Memory is
    // constructed or every agent silently shares the legacy `.db` file.
    const memoryAgentName = runtimeName || this.constructor.name.replace(/Agent$/, '').toLowerCase();
    this.name = memoryAgentName;
    this.memory = new Memory({
      dbPath: mc.dbPath || mc.db_path || '~/.skyloom',
      shortTermLimit: mc.shortTermLimit || mc.short_term_limit || 100,
      maxPersistedMessages: mc.maxPersistedMessages || mc.max_persisted_messages,
    }, memoryAgentName);

    // Stopping is PROGRESS-based, not round-count based (OpenClaw-style): a task
    // runs as long as it keeps making progress. The agent stops when it makes no
    // progress for `_maxNoProgressRounds` rounds in a row, or when the LoopGuard
    // detects a genuine loop. `_maxToolRoundsHardCap` is only a last-resort
    // backstop against pathological runaway and is set very high so normal long
    // tasks never reach it. All three are configurable under config.llm.
    const lc: any = (config as any).llm || {};
    const hard = Number(lc.max_tool_rounds_hard_cap ?? lc.maxToolRoundsHardCap);
    const noProg = Number(lc.max_no_progress_rounds ?? lc.maxNoProgressRounds);
    if (Number.isFinite(hard) && hard <= 0) {
      this._maxToolRoundsHardCap = 1_000_000; // effectively unlimited
    } else if (Number.isFinite(hard) && hard > 0) {
      this._maxToolRoundsHardCap = Math.floor(hard);
    } // else keep the generous default (1000)
    if (Number.isFinite(noProg) && noProg > 0) {
      this._maxNoProgressRounds = Math.floor(noProg);
    }
    // Back-compat: max_tool_rounds is no longer a hard stop, but if someone set
    // it we honor it as the hard cap so existing configs still bound the run.
    const legacySoft = Number(lc.max_tool_rounds ?? lc.maxToolRounds);
    if (Number.isFinite(legacySoft) && legacySoft > 0) {
      this._maxToolRoundsHardCap = Math.max(this._maxToolRoundsHardCap, Math.floor(legacySoft));
    }
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

  /** Consolidated environment snapshot (cwd/platform/git/date) — see envcontext. */
  protected injectEnvironment(prompt: string): string {
    try {
      const { buildEnvBlock } = require('./envcontext');
      const lang = (this.config as any).llm?.language || 'zh';
      return prompt + '\n\n' + buildEnvBlock({ lang });
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
        `\n\n## Thinking Protocol\nBefore acting, briefly weigh: (1) **What** is the actual need? (2) **How** sure am I? If <80%, flag with [uncertain] and ask.\nIf stuck, admit it — propose a partial answer or ask the user. Never fabricate.\n\n## Behavior\n- Act, don't narrate. No "I will..." before tool calls.\n- Stay in scope. Do what's asked, then stop.\n- Batch independent tool calls in one response.\n- For tasks with 3+ steps, plan with todo_write first and update item status as you go.\n- Verify writes: read back, report verified state.\n- For anything current or real-time (today's news/hot topics, recent events, latest versions, prices, weather), call web_search FIRST, then read_url for detail. Never answer from memory or claim you can't go online.\n- Call list_skills when the task needs specialized capabilities.`;
    }
    return prompt +
      `\n\n## 思考协议\n行动前快速判断：(1) 用户真实需求是什么？(2) 我有多大把握？低于80%标注 [不确定] 并主动询问。\n卡住时承认，给出部分答案或请求用户指导。绝不编造。\n\n## 行为守则\n- 直接行动,不预告。不说「我将要...」,直接调用工具\n- 不擅自扩大范围。用户要什么做什么,核心完成即止\n- 独立的工具调用一次发出,并行执行\n- 3 步以上的任务先用 todo_write 列任务清单,开工/完成时逐项更新状态\n- 写入后回读验证,汇报已验证状态而非仅尝试\n- 凡涉及最新/实时信息（今日新闻热点、近期事件、最新版本、价格、天气等）一律先调 web_search 联网核实，再用 read_url 读全文；绝不凭记忆作答，也不要声称无法联网\n- 任务涉及专业能力时（PPT/Excel/PDF/网页设计/代码审查等），先调 list_skills 查看可用技能，再用 use_skill 激活`;
  }

  protected injectProgrammingWisdom(prompt: string): string {
    const lang = (this.config as any).llm?.language || 'zh';
    try {
      const { engineeringProtocol } = require('./protocol');
      return prompt + '\n\n' + engineeringProtocol(lang);
    } catch {
      return prompt;
    }
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
    this._baseSystemPrompt = this.injectEnvironment(this._baseSystemPrompt);
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
    if (!this._initPromise) {
      this._initPromise = this.initialize().catch((error) => {
        this._initPromise = null;
        throw error;
      });
    }
    return this._initPromise;
  }

  private async initialize(): Promise<void> {
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
    this._baseSystemPrompt = this.injectEnvironment(this._baseSystemPrompt);
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

    // Note: the old `extend_rounds` tool was removed — stopping is now
    // progress-based (see chatStreamImpl), so there is no per-turn round budget
    // to extend. A productive task simply keeps running.

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

  activateSkill(name: string, source: 'manual' | 'auto' = 'manual'): boolean {
    let skill = this._skills.find(s => s.name === name);
    if (!skill) {
      const globalSkill = this.skillRegistry.get(name);
      if (globalSkill) {
        this._skills.push(globalSkill);
        skill = globalSkill;
      }
    }
    if (!skill) return false;

    if (this._activeSkills.has(name)) {
      if (source === 'manual') this._autoActiveSkills.delete(name);
      return true;
    }

    this._activeSkills.add(name);
    if (source === 'auto') this._autoActiveSkills.add(name);
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
    this._autoActiveSkills.delete(name);

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
    for (const name of [...this._autoActiveSkills]) this.deactivateSkill(name);
    this._autoActiveSkills.clear();
    if (!message) return [];

    const lowered = message.toLowerCase();
    const candidates = [...this._skills];
    for (const s of this.skillRegistry.getSkills()) {
      if (!candidates.find(c => c.name === s.name)) {
        candidates.push(s);
      }
    }

    const preferred = new Map(this.skillNames.map((name, index) => [name, index]));
    const matches: Array<{ skill: Skill; score: number; order: number }> = [];
    for (let order = 0; order < candidates.length; order++) {
      const skill = candidates[order];
      if (this._activeSkills.has(skill.name)) continue;
      if (!skill.triggers || !skill.triggers.length) continue;
      for (const trig of skill.triggers) {
        if (this.skillTriggerMatches(lowered, trig)) {
          const preferredIndex = preferred.get(skill.name);
          const score = (preferredIndex === undefined ? 0 : 1000 - preferredIndex) + trig.length;
          matches.push({ skill, score, order });
          break;
        }
      }
    }

    matches.sort((a, b) => b.score - a.score || a.order - b.order);
    const activated: string[] = [];
    for (const { skill } of matches.slice(0, 2)) {
      if (this.activateSkill(skill.name, 'auto')) activated.push(skill.name);
    }
    return activated;
  }

  private skillTriggerMatches(message: string, rawTrigger: string): boolean {
    const trigger = rawTrigger.trim().toLowerCase();
    if (!trigger) return false;
    if (!/^[a-z0-9][a-z0-9 ._+\/-]*$/i.test(trigger)) return message.includes(trigger);

    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(message);
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

  getAvailableSkills(): Array<{ name: string; description: string; active: boolean; recommended: boolean }> {
    const preferred = new Map(this.skillNames.map((name, index) => [name, index]));
    return [...this._skills]
      .sort((a, b) => {
        const ai = preferred.get(a.name);
        const bi = preferred.get(b.name);
        if (ai !== undefined && bi !== undefined) return ai - bi;
        if (ai !== undefined) return -1;
        if (bi !== undefined) return 1;
        return 0;
      })
      .map(s => ({
      name: s.name,
      description: s.description,
      active: this._activeSkills.has(s.name),
      recommended: preferred.has(s.name),
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
    options?: ToolCallExecutorOptions,
  ): Promise<ToolExecutionResult[]> {
    return new ToolCallExecutor({
      agentName: this.name,
      config: this.config,
      bus: this.bus,
      registry: this.toolRegistry,
      tracer: this.tracer,
      approve: (toolName, args) => this.checkToolApproval(toolName, args),
      setActing: () => this.setState(AgentState.ACTING),
      getHooks: () => this.getHooks(),
      markFilesWritten: () => { this._turnWroteFiles = true; },
      addToolMessage: (content, metadata) => this.memory.addMessage('tool', content, metadata),
    }).execute(toolCalls, options);
  }

  private createAgentLoop(): AgentLoop {
    return new AgentLoop({
      name: this.name,
      llm: this.llm,
      bus: this.bus,
      memory: this.memory,
      toolRegistry: this.toolRegistry,
      tracer: this.tracer,
      getActiveSkills: () => this._activeSkills,
      getSkills: () => this._skills,
      activeToolNames: () => this.activeToolNames(),
      getSkillConfigOverrides: () => this.getSkillConfigOverrides(),
      executeToolCalls: (calls, options) => this.executeToolCalls(calls, options),
      setState: (state) => this.setState(state),
      maybeExtractFacts: () => this.maybeExtractFacts(),
      messagesWithRecall: () => this.messagesWithRecall(),
      popLastUserMessage: () => this.popLastUserMessage(),
      shouldAutoCompact: () => this.shouldAutoCompact(),
      compact: () => this.compact(),
      resolveModelId: () => this.resolveModelId(),
      getPlanMode: () => this.planMode,
      maxToolRoundsHardCap: this._maxToolRoundsHardCap,
      maxNoProgressRounds: this._maxNoProgressRounds,
    });
  }

  async close(): Promise<void> {
    // Drain all in-flight work before closing memory so background writes land.
    const pending = [...this._pendingExtracts];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    await this._delegationCoordinator?.drain();
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
    } else {
      this.delegationCoordinator.handleEvent(event);
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
    onStatus?: ((status: string) => void) | null,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.sessionController.withTurn(() => this.chatImpl(message, onStatus, signal));
  }

  protected async chatImpl(
    message: string,
    onStatus?: ((status: string) => void) | null,
    signal?: AbortSignal,
  ): Promise<string> {
    this.autoActivateSkills(message);
    await this.setState(AgentState.THINKING);
    this.memory.addMessage('user', message);

    if (this.shouldAutoCompact()) {
      try { await this.compact(); } catch (e) { log.warn('auto_compact_failed', { error: String(e) }); }
    }

    try {
      if (onStatus) onStatus('thinking...');
      const response = await this.llmLoop({ onStatus, signal });
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
    yield* this.sessionController.runStream(
      message,
      (activated) => this.chatStreamImpl(message, activated, signal),
      undefined,
      signal,
    );
  }

  async *chatStreamInSession(
    sessionId: string,
    message: string,
    signal?: AbortSignal
  ): AsyncGenerator<Record<string, any>> {
    yield* this.sessionController.runStream(
      message,
      (activated) => this.chatStreamImpl(message, activated, signal),
      async () => {
        if (!await this.memory.loadSession(sessionId)) throw new Error('session not found');
      },
      signal,
    );
  }

  async *chatStreamInNamedSession(
    sessionName: string,
    message: string,
    signal?: AbortSignal
  ): AsyncGenerator<Record<string, any>> {
    yield* this.sessionController.runStream(
      message,
      (activated) => this.chatStreamImpl(message, activated, signal),
      async () => { await this.memory.loadOrCreateNamedSession(sessionName); },
      signal,
    );
  }

  /** The most recently completed (or in-progress) run trace. */
  getLastTrace(): Trace | null { return this.tracer.last(); }

  protected async *chatStreamImpl(
    message: string,
    autoActivated?: string[],
    signal?: AbortSignal
  ): AsyncGenerator<Record<string, any>> {
    yield* this.createAgentLoop().runStream(message, autoActivated, signal);
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

  protected async llmLoop(options?: BatchLoopOptions) {
    return this.createAgentLoop().runBatch(options);
  }

  async executeTask(
    task: Task,
    onStatus?: ((status: string) => void) | null,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    return this.sessionController.withTurn(async () => {
      this.tracer.startTrace(`[task] ${task.description}`.replace(/\s+/g, ' ').slice(0, 80), this.name);
      try {
        return await this.executeTaskImpl(task, onStatus, signal);
      } finally {
        this.tracer.endTrace();
      }
    });
  }

  private async executeTaskImpl(
    task: Task,
    onStatus?: ((status: string) => void) | null,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    await this.setState(AgentState.THINKING);
    task.transitionTo(TaskState.RUNNING);
    this.memory.setWorking('current_task', task);

    let prompt = `Complete this task NOW using your available tools. Then write the actual deliverable content in your final reply.\n\nTask: ${task.description}`;
    if (task.metadata) {
      const ctxData: Record<string, any> = {};
      for (const [k, v] of Object.entries(task.metadata)) {
        if (k !== 'goal') ctxData[k] = v;
      }
      if (Object.keys(ctxData).length > 0) {
        prompt += `\nContext: ${JSON.stringify(ctxData)}`;
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
      let response = await this.llmLoop({ onStatus, ephemeral: true, signal });

      // ── 验证闭环: if this task touched the filesystem and verify commands
      // are configured (config.verify or SKY.md "## Verify"), run them and
      // feed failures back for a bounded number of fix rounds. ──
      try {
        const vc = resolveVerifyConfig(this.config);
        if (vc.commands.length > 0 && this._turnWroteFiles) {
          for (let round = 0; round <= vc.maxFixRounds; round++) {
            signal?.throwIfAborted();
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
            response = await this.llmLoop({ onStatus, ephemeral: true, signal });
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
      const cancelled = signal?.aborted || (e as { name?: string })?.name === 'AbortError';
      task.result = cancelled ? '[cancelled] task interrupted by user' : String(e);
      this.memory.pruneToolMessages();
      await this.setState(cancelled ? AgentState.IDLE : AgentState.ERROR);
      return new TaskResult(false, task.result);
    } finally {
      // Restore chat history
      this.memory.shortTerm = savedShortTerm!;
    }
  }

  get security(): SecurityContext { return getSecurity(); }

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
      log.error('approval_check_unavailable', { tool: toolName, agent: this.name });
    } catch (error) {
      log.error('approval_check_failed', { tool: toolName, agent: this.name, error });
    }
    return false;
  }

  async requestHelp(
    targetAgent: string,
    description: string,
    timeout: number = 60,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.delegationCoordinator.requestHelp(targetAgent, description, timeout, signal);
  }

  private get delegationCoordinator(): DelegationCoordinator {
    if (!this._delegationCoordinator) {
      this._delegationCoordinator = new DelegationCoordinator({
        agentName: () => this.name,
        bus: this.bus,
        executeTask: (task, signal) => this.executeTask(task, undefined, signal),
      });
    }
    return this._delegationCoordinator;
  }

  private get sessionController(): AgentSessionController {
    if (!this._sessionController) {
      this._sessionController = new AgentSessionController({
        agentName: () => this.name,
        tracer: this.tracer,
        getShortTerm: () => this.memory.shortTerm,
        autoActivateSkills: (message) => this.autoActivateSkills(message),
        popLastUserMessage: () => this.popLastUserMessage(),
      });
    }
    return this._sessionController;
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

  getToolStats() {
    return this.toolRegistry.getStats();
  }
}
