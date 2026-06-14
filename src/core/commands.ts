/**
 * 天空织机 · 命令注册中心 — Centralized Slash Command Registry
 *
 * Inspired by opencode's command architecture:
 * - Each command has a name, aliases, description, category, and hints
 * - Commands are organized by category for better UX
 * - The registry provides list(), get(), and search() methods
 * - Supports argument hints auto-detection from templates
 *
 * This registry is the single source of truth for the slash-command surface:
 * the TUI palette and tab-completer derive their list from `slashItems()`, so
 * adding a command here makes it show up everywhere — no parallel hand-kept
 * arrays to drift out of sync.
 *
 * Two command types:
 *   1. TUI commands — execute UI actions directly (undo, compact, etc.)
 *   2. Prompt commands — expand to LLM prompt templates (init, review, etc.)
 */

export type CommandCategory =
  | 'session'      // session management
  | 'agent'        // agent switching
  | 'model'        // model configuration
  | 'memory'       // memory operations
  | 'context'      // context & diagnostics
  | 'workflow'     // workflow & orchestration
  | 'file'         // file & checkpoint operations
  | 'config'       // configuration
  | 'ui'           // UI/display toggles
  | 'system';      // system & exit

export interface CommandInfo {
  /** Command name (without /). */
  name: string;
  /** Aliases that map to the same command. */
  aliases: string[];
  /** Short description shown in autocomplete (English). */
  description: string;
  /** Localized (zh) display label for the TUI palette. Falls back to `description`. */
  label?: string;
  /** Category for grouping. */
  category: CommandCategory;
  /** Argument hints (auto-detected or manual). */
  hints: string[];
  /** Whether this command takes arguments. */
  takesArgs: boolean;
  /**
   * Command is meaningless without an argument (e.g. /resume, /task). The
   * palette fills the input and waits for the argument instead of running on
   * Enter, and the derived token carries a trailing space.
   */
  argRequired?: boolean;
  /**
   * Catalogued but not yet wired to a live handler. Kept in the registry for
   * roadmap/documentation, but omitted from the palette so we never advertise
   * a command that does nothing.
   */
  hidden?: boolean;
  /** Optional: agent to route to. */
  agent?: string;
  /** Optional: model override. */
  model?: string;
  /** Whether this runs as a subtask (subagent). */
  subtask?: boolean;
  /** Source of the command. */
  source: 'builtin' | 'config' | 'mcp' | 'skill' | 'custom';
}

export interface CommandHandler {
  (args: {
    input: string;
    agent: any;
    ctx: any;
    mode: any;
    ui?: any;
  }): Promise<void> | void;
}

/**
 * All built-in slash commands for Skyloom.
 * Organized by category.
 */
export const BUILTIN_COMMANDS: CommandInfo[] = [
  // ── Session ─
  {
    name: 'new',
    aliases: [],
    description: 'Start a new session',
    label: '开始新会话',
    category: 'session',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'sessions',
    aliases: [],
    description: 'List and switch sessions',
    label: '会话列表',
    category: 'session',
    hints: ['<index|id>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'resume',
    aliases: [],
    description: 'Resume a previous session',
    label: '恢复会话（序号/id）',
    category: 'session',
    hints: ['<index|id>'],
    takesArgs: true,
    argRequired: true,
    source: 'builtin',
  },
  {
    name: 'export',
    aliases: [],
    description: 'Export conversation to Markdown',
    label: '导出对话为 Markdown',
    category: 'session',
    hints: ['[filename]'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'share',
    aliases: [],
    description: 'Share current session',
    label: '分享当前会话',
    category: 'session',
    hints: [],
    takesArgs: false,
    hidden: true,
    source: 'builtin',
  },
  {
    name: 'unshare',
    aliases: [],
    description: 'Unshare current session',
    label: '取消分享',
    category: 'session',
    hints: [],
    takesArgs: false,
    hidden: true,
    source: 'builtin',
  },
  {
    name: 'move',
    aliases: [],
    description: 'Move session to another project directory',
    label: '移动会话到项目目录',
    category: 'session',
    hints: ['<path>'],
    takesArgs: true,
    source: 'builtin',
  },

  // ── Agent ──
  {
    name: 'fog',
    aliases: [],
    description: 'Fog — research & insight',
    label: '≋ 雾 · 探索洞察',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'rain',
    aliases: [],
    description: 'Rain — creation & codegen',
    label: '⸽ 雨 · 创造产出',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'frost',
    aliases: [],
    description: 'Frost — review & quality',
    label: '✱ 霜 · 精炼品质',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'snow',
    aliases: [],
    description: 'Snow — planning & architecture',
    label: '❉ 雪 · 架构规划',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'dew',
    aliases: [],
    description: 'Dew — devops & reliability',
    label: '∘ 露 · 可靠守护',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'fair',
    aliases: [],
    description: 'Fair — companion & warmth',
    label: '☼ 晴 · 情感陪伴',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },

  // ── Model ──
  {
    name: 'model',
    aliases: [],
    description: 'Model info & switch',
    label: '查看/切换模型（独立/统一）',
    category: 'model',
    hints: ['<id>', 'unified <id>', 'reset', 'key <key>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'models',
    aliases: [],
    description: 'Browse all available models',
    label: '浏览全部可用模型',
    category: 'model',
    hints: ['[provider]'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'connect',
    aliases: [],
    description: 'Add or configure a provider',
    label: '添加/配置提供商',
    category: 'model',
    hints: ['<provider>'],
    takesArgs: true,
    source: 'builtin',
  },

  // ── Memory ──
  {
    name: 'memory',
    aliases: [],
    description: 'Memory stats',
    label: '记忆状态',
    category: 'memory',
    hints: ['clear'],
    takesArgs: true,
    source: 'builtin',
  },

  // ── Context & Diagnostics ──
  {
    name: 'status',
    aliases: [],
    description: 'Agent overview',
    label: '状态总览',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'cost',
    aliases: [],
    description: 'Usage & cost',
    label: '费用统计',
    category: 'context',
    hints: ['reset'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'context',
    aliases: [],
    description: 'Token usage breakdown',
    label: '上下文占用明细',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'tools',
    aliases: [],
    description: 'Tool call statistics',
    label: '工具调用统计',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'trace',
    aliases: [],
    description: 'Run trace of the last turn (span tree)',
    label: '本轮运行追踪（span 树）',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'agents',
    aliases: [],
    description: 'List spawnable subagents',
    label: '可派生子智能体',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'workspace',
    aliases: [],
    description: 'Workspace info',
    label: '工作空间',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'version',
    aliases: [],
    description: 'Version info',
    label: '版本信息',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },

  // ─ Workflow ──
  {
    name: 'compact',
    aliases: ['summarize'],
    description: 'Compress/summarize context',
    label: '压缩上下文',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'retry',
    aliases: [],
    description: 'Resend last message',
    label: '重发上一条消息',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    hidden: true,
    source: 'builtin',
  },
  {
    name: 'task',
    aliases: [],
    description: 'Multi-agent orchestration',
    label: '多 Agent 编排',
    category: 'workflow',
    hints: ['<goal>'],
    takesArgs: true,
    argRequired: true,
    source: 'builtin',
  },
  {
    name: 'init',
    aliases: [],
    description: 'Generate SKY.md project memory',
    label: '扫描项目生成 SKY.md',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'review',
    aliases: [],
    description: 'Code review of changes',
    label: '审查代码改动',
    category: 'workflow',
    hints: ['[commit|branch|pr]'],
    takesArgs: true,
    subtask: true,
    source: 'builtin',
  },
  {
    name: 'verify',
    aliases: [],
    description: 'Run verification commands',
    label: '运行项目验证命令',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Enter plan mode (read-only tools)',
    label: '切换计划模式（只读出方案）',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Enter auto mode (no approval)',
    label: '自动模式（免审批）',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'default',
    aliases: [],
    description: 'Return to default mode',
    label: '返回默认模式',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'perm',
    aliases: [],
    description: 'Set permission mode (default|auto|accept|strict|bypass)',
    label: '权限模式（default/auto/accept/strict/bypass）',
    category: 'workflow',
    hints: ['default', 'auto', 'accept', 'strict', 'bypass'],
    takesArgs: true,
    source: 'builtin',
  },

  // ── File & Checkpoint ──
  {
    name: 'rewind',
    aliases: ['undo'],
    description: 'Undo last turn (revert file changes)',
    label: '回退本轮文件改动',
    category: 'file',
    hints: ['[n]'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'redo',
    aliases: [],
    description: 'Redo a previously undone turn',
    label: '重做已撤销的回合',
    category: 'file',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },

  // ── Config ──
  {
    name: 'setup',
    aliases: [],
    description: 'Setup wizard (provider, key, model)',
    label: '配置向导',
    category: 'config',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'apikey',
    aliases: [],
    description: 'Manage API keys',
    label: '管理 API 密钥',
    category: 'config',
    hints: ['set <provider> <key>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'MCP server status',
    label: 'MCP 服务器',
    category: 'config',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },

  // ── UI ──
  {
    name: 'clear',
    aliases: [],
    description: 'Clear the screen',
    label: '清屏',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'help',
    aliases: [],
    description: 'Show all commands',
    label: '查看所有命令',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'thinking',
    aliases: [],
    description: 'Toggle reasoning block visibility',
    label: '切换思考过程显示',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'details',
    aliases: [],
    description: 'Toggle tool execution details',
    label: '切换工具执行详情',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'skills',
    aliases: [],
    description: 'Browse available skills',
    label: '浏览可用技能',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'warp',
    aliases: [],
    description: 'Change workspace for this session',
    label: '切换本会话工作区',
    category: 'ui',
    hints: ['<path>'],
    takesArgs: true,
    source: 'builtin',
  },

  // ─ System ──
  {
    name: 'quit',
    aliases: ['exit'],
    description: 'Exit chat',
    label: '退出',
    category: 'system',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
];

/**
 * Command registry — provides lookup, listing, and search.
 */
export class CommandRegistry {
  private commands: Map<string, CommandInfo> = new Map();
  private handlers: Map<string, CommandHandler> = new Map();

  constructor() {
    // Register all built-in commands
    for (const cmd of BUILTIN_COMMANDS) {
      this.register(cmd);
    }
  }

  /** Register a command. */
  register(info: CommandInfo, handler?: CommandHandler): void {
    this.commands.set(info.name, info);
    for (const alias of info.aliases) {
      this.commands.set(alias, { ...info, name: alias });
    }
    if (handler) {
      this.handlers.set(info.name, handler);
    }
  }

  /** Get command info by name or alias. */
  get(name: string): CommandInfo | undefined {
    return this.commands.get(name);
  }

  /** Get handler for a command. */
  getHandler(name: string): CommandHandler | undefined {
    const info = this.commands.get(name);
    if (!info) return undefined;
    return this.handlers.get(info.name);
  }

  /** Register a handler for an existing command. */
  setHandler(name: string, handler: CommandHandler): void {
    this.handlers.set(name, handler);
  }

  /** List all commands, optionally filtered by category. */
  list(category?: CommandCategory): CommandInfo[] {
    const seen = new Set<string>();
    const result: CommandInfo[] = [];
    for (const cmd of BUILTIN_COMMANDS) {
      if (category && cmd.category !== category) continue;
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      result.push(cmd);
    }
    return result;
  }

  /** List commands grouped by category. */
  listByCategory(): Map<CommandCategory, CommandInfo[]> {
    const groups = new Map<CommandCategory, CommandInfo[]>();
    for (const cmd of this.list()) {
      const existing = groups.get(cmd.category) || [];
      existing.push(cmd);
      groups.set(cmd.category, existing);
    }
    return groups;
  }

  /**
   * Category-grouped help lines for `/help`. Section headers are prefixed with
   * "§ "; command lines are indented. Hidden (unwired) commands are omitted.
   */
  renderHelp(lang: 'zh' | 'en' = 'zh'): string[] {
    const order: CommandCategory[] = ['agent', 'session', 'model', 'config', 'workflow', 'context', 'memory', 'file', 'ui', 'system'];
    const groups = this.listByCategory();
    const lines: string[] = [];
    for (const cat of order) {
      const cmds = (groups.get(cat) || []).filter((c) => !c.hidden);
      if (!cmds.length) continue;
      lines.push(`§ ${CommandRegistry.categoryLabel(cat)}`);
      for (const c of cmds) {
        const name = '/' + c.name + (c.argRequired ? ' …' : '');
        const desc = lang === 'zh' ? (c.label ?? c.description) : c.description;
        lines.push(`  ${name.padEnd(12)} ${desc}`);
      }
    }
    return lines;
  }

  /**
   * Build the `[token, label]` pairs the TUI palette + tab-completer consume.
   *
   * - Hidden (catalogued-but-unwired) commands are omitted so the palette only
   *   advertises commands that actually run.
   * - Argument-required commands get a trailing space in the token; the loom
   *   palette keys off that to fill the input and wait for the argument instead
   *   of executing on Enter.
   * - `lang: 'zh'` uses the localized label (the default, product language);
   *   `'en'` uses the English description.
   */
  slashItems(lang: 'zh' | 'en' = 'zh'): [string, string][] {
    // Lead with the agent switches — the most common action — then the rest in
    // catalog order. This keeps the agents prominent at the top of the palette.
    const visible = this.list().filter(c => !c.hidden);
    const ordered = [
      ...visible.filter(c => c.category === 'agent'),
      ...visible.filter(c => c.category !== 'agent'),
    ];
    return ordered.map((cmd) => {
      const token = '/' + cmd.name + (cmd.argRequired ? ' ' : '');
      const label = lang === 'zh' ? (cmd.label ?? cmd.description) : cmd.description;
      return [token, label] as [string, string];
    });
  }

  /** Search commands by query (fuzzy match on name + description + label). */
  search(query: string): CommandInfo[] {
    if (!query) return this.list();
    const q = query.toLowerCase();
    const seen = new Set<string>();
    const result: CommandInfo[] = [];
    for (const cmd of BUILTIN_COMMANDS) {
      if (seen.has(cmd.name)) continue;
      const nameMatch = cmd.name.toLowerCase().includes(q);
      const descMatch = cmd.description.toLowerCase().includes(q);
      const labelMatch = (cmd.label || '').toLowerCase().includes(q);
      const aliasMatch = cmd.aliases.some(a => a.toLowerCase().includes(q));
      if (nameMatch || descMatch || labelMatch || aliasMatch) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  /** Get all command names (for autocomplete). */
  names(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const cmd of BUILTIN_COMMANDS) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      result.push(cmd.name);
    }
    return result;
  }

  /** Get category display label. */
  static categoryLabel(cat: CommandCategory): string {
    const labels: Record<CommandCategory, string> = {
      session: '会话管理',
      agent: 'Agent 切换',
      model: '模型配置',
      memory: '记忆操作',
      context: '上下文与诊断',
      workflow: '工作流',
      file: '文件与检查点',
      config: '配置',
      ui: '界面',
      system: '系统',
    };
    return labels[cat] || cat;
  }
}

/** Singleton registry instance. */
export const registry = new CommandRegistry();
