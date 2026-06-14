/**
 * Subagents — general-purpose, user-definable agents spawned with an ISOLATED
 * context to handle one focused, self-contained task (the `spawn_agent` tool).
 *
 * This mirrors Claude Code's Task tool / opencode subagents: an orchestrator
 * spins up a child agent that has its own fresh memory and a (optionally
 * restricted) tool set, runs it to completion, and gets back only the child's
 * final report — keeping the parent's context clean.
 *
 * Definitions come from three places (later wins on name collision):
 *   1. built-in:  general-purpose, explore
 *   2. user:      ~/.claude/agents/  (Claude Code compatible), ~/.skyloom/agents/
 *   3. project:   <cwd>/.claude/agents/, <cwd>/.sky/agents/
 *
 * Each file is `<root>/<name>.md` with Claude Code compatible YAML frontmatter
 * (name / description / tools / model). The body is the subagent's system
 * prompt. `tools` accepts Claude names (Read, Grep, Bash…) — they're aliased to
 * sky's registry names. Omitting `tools` grants the full inherited tool set.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

import { BaseAgent } from './agent';
import type { MessageBus } from './bus';
import { LLMClient } from './llm';
import { ToolRegistry } from './tool';
import { SkillRegistry } from './skill';
import { normalizeClaudeToolName } from './skill';
import { getLogger } from './logger';

const log = getLogger('subagent');

export interface SubagentDefinition {
  /** Identifier used as `agent_type` in the spawn_agent tool. */
  name: string;
  /** One-line summary — shown to the orchestrator to choose the right subagent. */
  description: string;
  /** The subagent's system prompt (markdown body of the definition file). */
  systemPrompt: string;
  /** Allowlist of tool names; `null` means inherit the full tool set. */
  tools: string[] | null;
  /** Optional model override (else the spawning agent's default model). */
  model?: string;
  /** Where this definition came from: 'builtin' or an absolute file path. */
  source: string;
}

/** Read-only tools for the `explore` subagent — search/read, never mutate. */
export const READ_ONLY_TOOLS = [
  'read_file', 'list_directory', 'tree', 'file_search', 'code_search', 'grep',
  'web_search', 'fetch_page', 'http_get',
  'git_status', 'git_diff', 'git_log',
  'system_info',
];

const BUILTIN_DEFS: SubagentDefinition[] = [
  {
    name: 'general-purpose',
    description: '通用子智能体 — 研究复杂问题、搜索代码、执行多步任务。当你不确定一两次能否定位答案时,把搜索/调研整段交给它。',
    systemPrompt:
      '你是一个通用子智能体,擅长把一个目标拆成步骤并用工具逐一推进:搜索、阅读、分析、必要时修改,然后汇报。' +
      '独立完成任务,不要反问;遇到歧义就合理假设并说明。最终回复要完整自洽 —— 编排者只看得到这一条。',
    tools: null,
    source: 'builtin',
  },
  {
    name: 'explore',
    description: '只读探索子智能体 — 在大量文件/目录中做广度搜索,只读不写。需要"扫一遍代码库定位某物"且只要结论时用它。',
    systemPrompt:
      '你是一个只读探索子智能体。你的工作是在代码库/网络中快速定位信息并给出结论,绝不修改任何文件。' +
      '优先用 grep / code_search / file_search / tree 做广度扫描,读取关键片段而非整文件。' +
      '汇报时给出精确的文件路径与行号(file_path:line),以及一段简明结论。',
    tools: READ_ONLY_TOOLS,
    source: 'builtin',
  },
];

/** User/project subagent definition roots, lowest precedence first. */
export function subagentDirs(cwd: string = process.cwd()): string[] {
  return [
    path.join(os.homedir(), '.claude', 'agents'),
    path.join(os.homedir(), '.skyloom', 'agents'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.sky', 'agents'),
  ];
}

function parseToolsField(raw: unknown): string[] | null {
  let list: string[] | null = null;
  if (Array.isArray(raw)) {
    list = raw.filter((t): t is string => typeof t === 'string');
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'all') return null;
    list = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  } else {
    return null; // omitted → inherit all
  }
  if (!list || list.length === 0) return null;
  // Normalize Claude names → sky names, dedupe preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list.map(normalizeClaudeToolName)) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Parse a single `<name>.md` subagent definition file. */
export function parseSubagentFile(filePath: string): SubagentDefinition | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let fm: Record<string, any> = {};
  let body = text;
  const m = text.match(/^---\s*\n(.*?)\n---\s*\n?(.*)/s);
  if (m) {
    try { fm = parseYaml(m[1]) || {}; } catch { fm = {}; }
    body = m[2];
  }
  const fileBase = path.basename(filePath).replace(/\.md$/i, '');
  const name = (typeof fm.name === 'string' && fm.name.trim()) ? fm.name.trim() : fileBase;
  if (!name) return null;
  const description = (typeof fm.description === 'string' && fm.description.trim())
    ? fm.description.trim()
    : `自定义子智能体 ${name}`;
  const model = (typeof fm.model === 'string' && fm.model.trim()) ? fm.model.trim() : undefined;
  return {
    name,
    description,
    systemPrompt: body.trim() || `你是 ${name} 子智能体。${description}`,
    tools: parseToolsField(fm.tools),
    model,
    source: filePath,
  };
}

/**
 * Load all subagent definitions: built-ins overlaid by user then project files.
 * Cheap enough to call per spawn so edits to definition files apply live.
 */
export function loadSubagentDefinitions(cwd: string = process.cwd()): Map<string, SubagentDefinition> {
  const map = new Map<string, SubagentDefinition>();
  for (const d of BUILTIN_DEFS) map.set(d.name, d);

  for (const dir of subagentDirs(cwd)) {
    let entries: string[];
    try {
      if (!fs.existsSync(dir)) continue;
      entries = fs.readdirSync(dir);
    } catch { continue; }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const def = parseSubagentFile(path.join(dir, entry));
      if (def) map.set(def.name, def);
    }
  }
  return map;
}

/**
 * A generic agent built from a SubagentDefinition. Reuses the full BaseAgent
 * reasoning loop but supplies its own identity block (the team-persona block
 * would crash for a non-team name).
 */
export class GenericSubagent extends BaseAgent {
  private _subDef: SubagentDefinition;

  constructor(
    def: SubagentDefinition,
    config: any,
    llm: LLMClient,
    bus: MessageBus,
    toolRegistry: ToolRegistry,
    skillRegistry: SkillRegistry,
    runtimeName: string,
  ) {
    super(config, llm, bus, toolRegistry, skillRegistry);
    this.name = runtimeName;
    this.displayName = def.name;
    this.emoji = '◇';
    this.specialty = def.description;
    this.systemPrompt = def.systemPrompt;
    this._subDef = def;
  }

  protected runtimeIdentityBlock(): string {
    const lang = (this.config as any).llm?.language || 'zh';
    if (lang === 'en') {
      return `\n\n## Who You Are\nYou are the **${this._subDef.name}** subagent — ${this._subDef.description}\nYou run in an ISOLATED context spawned by an orchestrator for one focused, self-contained task. The orchestrator sees ONLY your final message, never your intermediate steps. So your final message must be a COMPLETE, self-contained report: what you found, what you did, and concrete results (file paths, code, answers). Be thorough; do not ask follow-up questions — make reasonable assumptions and act.`;
    }
    return `\n\n## 你是谁\n你是 **${this._subDef.name}** 子智能体 —— ${this._subDef.description}\n你运行在编排者派生的**隔离上下文**中,负责一个聚焦、自洽的任务。编排者只能看到你的最终回复,看不到任何中间步骤。因此你的最终回复必须是一份**完整、自洽的报告**:你发现了什么、做了什么、以及具体结果(文件路径、代码、答案)。要彻底;不要反问,合理假设后直接行动。`;
  }
}

let _spawnSeq = 0;

/**
 * Run a subagent to completion in an isolated context and return its final
 * report. Creates an ephemeral on-disk memory in a temp dir and removes it
 * afterward, so nothing leaks into the parent agent or the user's ~/.skyloom.
 */
export async function runSubagent(opts: {
  def: SubagentDefinition;
  task: string;
  config: any;
  llm: LLMClient;
  bus: MessageBus;
  baseToolRegistry: ToolRegistry;
  baseSkillRegistry: SkillRegistry;
  onStatus?: ((status: string) => void) | null;
}): Promise<string> {
  const { def, task, config, llm, bus, baseToolRegistry, baseSkillRegistry, onStatus } = opts;

  const safe = def.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'sub';
  const runtimeName = `sub-${safe}-${Date.now().toString(36)}-${(_spawnSeq++).toString(36)}`;

  // Filtered tool registry (allowlist), never carrying spawn_agent (no recursion).
  const reg = new ToolRegistry();
  reg.merge(baseToolRegistry);
  if (def.tools !== null) {
    const allow = new Set(def.tools);
    for (const n of reg.listNames()) {
      if (!allow.has(n)) reg.unregister(n);
    }
  }
  reg.unregister('spawn_agent');
  reg.unregister('delegate_to');

  const skills = new SkillRegistry();
  skills.merge(baseSkillRegistry);

  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-sub-'));
  } catch (e) {
    return `[spawn_agent error] could not create isolated workspace: ${e}`;
  }

  const subConfig = {
    ...config,
    agents: {
      ...(config?.agents || {}),
      [runtimeName]: def.model ? { model: def.model } : {},
    },
    memory: {
      ...(config?.memory || {}),
      dbPath: path.join(tmpDir, 'mem'),
    },
  };

  const agent = new GenericSubagent(def, subConfig, llm, bus, reg, skills, runtimeName);

  try {
    await agent.init();
    if (onStatus) onStatus(`spawn ${def.name}…`);
    const report = await agent.chat(task, onStatus || undefined);
    return report || '(subagent produced no output)';
  } catch (e) {
    log.warn('subagent_run_failed', { agent: def.name, error: String(e) });
    return `[spawn_agent error] subagent '${def.name}' failed: ${e}`;
  } finally {
    try { await agent.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
