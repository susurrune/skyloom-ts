/**
 * 天空织机 · 命令注册中心 — Centralized Slash Command Registry
 *
 * Inspired by opencode's command architecture:
 * - Each command has a name, aliases, description, category, and hints
 * - Commands are organized by category for better UX
 * - The registry provides list(), get(), and search() methods
 * - Supports argument hints auto-detection from templates
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
  /** Short description shown in autocomplete. */
  description: string;
  /** Category for grouping. */
  category: CommandCategory;
  /** Argument hints (auto-detected or manual). */
  hints: string[];
  /** Whether this command takes arguments. */
  takesArgs: boolean;
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
    aliases: ['clear'],
    description: 'Start a new session',
    category: 'session',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'sessions',
    aliases: ['resume', 'continue'],
    description: 'List and switch sessions',
    category: 'session',
    hints: ['<index|id>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'resume',
    aliases: [],
    description: 'Resume a previous session',
    category: 'session',
    hints: ['<index|id>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'export',
    aliases: [],
    description: 'Export conversation to Markdown',
    category: 'session',
    hints: ['[filename]'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'share',
    aliases: [],
    description: 'Share current session',
    category: 'session',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'unshare',
    aliases: [],
    description: 'Unshare current session',
    category: 'session',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'move',
    aliases: [],
    description: 'Move session to another project directory',
    category: 'session',
    hints: ['<path>'],
    takesArgs: true,
    source: 'builtin',
  },

  // ── Agent ──
  {
    name: 'fog',
    aliases: [],
    description: ' Fog — research & insight',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'rain',
    aliases: [],
    description: ' Rain — creation & codegen',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'frost',
    aliases: [],
    description: '✱ Frost — review & quality',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'snow',
    aliases: [],
    description: ' Snow — planning & architecture',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'dew',
    aliases: [],
    description: '∘ Dew — devops & reliability',
    category: 'agent',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'fair',
    aliases: [],
    description: '☼ Fair — companion & warmth',
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
    category: 'model',
    hints: ['<id>', 'unified <id>', 'reset', 'key <key>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'models',
    aliases: [],
    description: 'Browse all available models',
    category: 'model',
    hints: ['[provider]'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'connect',
    aliases: [],
    description: 'Add or configure a provider',
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
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'cost',
    aliases: [],
    description: 'Usage & cost',
    category: 'context',
    hints: ['reset'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'context',
    aliases: [],
    description: 'Token usage breakdown',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'tools',
    aliases: [],
    description: 'Tool call statistics',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'workspace',
    aliases: [],
    description: 'Workspace info',
    category: 'context',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'version',
    aliases: [],
    description: 'Version info',
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
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'retry',
    aliases: [],
    description: 'Resend last message',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'task',
    aliases: [],
    description: 'Multi-agent orchestration',
    category: 'workflow',
    hints: ['<goal>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'init',
    aliases: [],
    description: 'Generate SKY.md project memory',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'review',
    aliases: [],
    description: 'Code review of changes',
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
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Enter plan mode (read-only tools)',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Enter auto mode (no approval)',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'default',
    aliases: [],
    description: 'Return to default mode',
    category: 'workflow',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },

  // ── File & Checkpoint ──
  {
    name: 'rewind',
    aliases: ['undo'],
    description: 'Undo last turn (revert file changes)',
    category: 'file',
    hints: ['[n]'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'redo',
    aliases: [],
    description: 'Redo a previously undone turn',
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
    category: 'config',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'apikey',
    aliases: [],
    description: 'Manage API keys',
    category: 'config',
    hints: ['set <provider> <key>'],
    takesArgs: true,
    source: 'builtin',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'MCP server status',
    category: 'config',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },

  // ── UI ──
  {
    name: 'help',
    aliases: [],
    description: 'Show all commands',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'thinking',
    aliases: [],
    description: 'Toggle reasoning block visibility',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'details',
    aliases: [],
    description: 'Toggle tool execution details',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'skills',
    aliases: [],
    description: 'Browse available skills',
    category: 'ui',
    hints: [],
    takesArgs: false,
    source: 'builtin',
  },
  {
    name: 'warp',
    aliases: [],
    description: 'Change workspace for this session',
    category: 'ui',
    hints: ['<path>'],
    takesArgs: true,
    source: 'builtin',
  },

  // ─ System ──
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    description: 'Exit chat',
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

  /** Search commands by query (fuzzy match on name + description). */
  search(query: string): CommandInfo[] {
    if (!query) return this.list();
    const q = query.toLowerCase();
    const seen = new Set<string>();
    const result: CommandInfo[] = [];
    for (const cmd of BUILTIN_COMMANDS) {
      if (seen.has(cmd.name)) continue;
      const nameMatch = cmd.name.toLowerCase().includes(q);
      const descMatch = cmd.description.toLowerCase().includes(q);
      const aliasMatch = cmd.aliases.some(a => a.toLowerCase().includes(q));
      if (nameMatch || descMatch || aliasMatch) {
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
