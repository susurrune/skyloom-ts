/**
 * 斜杠命令向导 · Cascading argument wizard for slash commands.
 *
 * After a slash command that takes structured arguments is chosen in the loom
 * palette, the TUI walks the user through its arguments one level at a time:
 * pick a provider, then paste a key; pick a model; pick a session. Each level is
 * navigable with ↑/↓ and filterable by typing — the same affordance as the
 * command palette itself, extended to arguments.
 *
 * This module is the pure brain of that flow (no I/O, no terminal) so it is
 * fully unit-testable: given a command, the values chosen so far, and a snapshot
 * of runtime context, it returns the next step — or null when the command is
 * complete and ready to submit.
 */

export interface ArgChoice {
  /** The value contributed to the final command line. */
  value: string;
  /** Display label in the list. */
  label: string;
  /** Optional dim hint shown after the label. */
  hint?: string;
  /** Optional group heading (e.g. provider name) for sectioned lists. */
  group?: string;
}

export interface WizardStep {
  kind: 'choice' | 'freeform';
  /** Heading shown above the list / prompt. */
  title: string;
  /** Choices for a 'choice' step (already ordered). */
  choices: ArgChoice[];
  /** A 'choice' step may also accept a typed value not in the list. */
  allowFreeform: boolean;
  /** Placeholder for a 'freeform' step (or a free-typed choice). */
  placeholder?: string;
  /** Mask typed input (API keys). */
  secret?: boolean;
}

export interface WizardProvider { id: string; label: string; configured: boolean; envVar?: string }
export interface WizardModel { id: string; provider: string; label: string; hint?: string }
export interface WizardSession { id: string; label: string }

export interface WizardContext {
  providers: WizardProvider[];
  models: WizardModel[];
  sessions: WizardSession[];
}

/** Commands that drive a guided wizard (base name without the leading slash). */
const WIZARD_COMMANDS = new Set(['model', 'apikey', 'connect', 'resume']);

/** Does this base command (with or without leading slash) have a wizard? */
export function hasWizard(command: string): boolean {
  return WIZARD_COMMANDS.has(command.replace(/^\//, '').trim().toLowerCase());
}

function providerChoices(ctx: WizardContext): ArgChoice[] {
  return ctx.providers.map((p) => ({
    value: p.id,
    label: p.label,
    hint: p.configured ? '✓ 已配置' : (p.envVar ? `需 ${p.envVar}` : '未配置'),
  }));
}

function modelChoices(ctx: WizardContext): ArgChoice[] {
  return ctx.models.map((m) => ({
    value: m.id,
    label: m.id,
    hint: m.hint,
    group: m.provider,
  }));
}

/**
 * The next step for `command` given the values already chosen, or null when the
 * command is complete (ready to submit via {@link buildCommandLine}).
 */
export function nextWizardStep(command: string, prior: string[], ctx: WizardContext): WizardStep | null {
  const cmd = command.replace(/^\//, '').trim().toLowerCase();

  switch (cmd) {
    case 'model': {
      if (prior.length >= 1) return null;
      const choices: ArgChoice[] = [
        { value: 'reset', label: '↺ reset', hint: '回到统一默认模型' },
        ...modelChoices(ctx),
      ];
      return { kind: 'choice', title: '选择模型（输入可筛选）', choices, allowFreeform: true, placeholder: '模型 id' };
    }

    case 'connect': {
      if (prior.length >= 1) return null;
      return { kind: 'choice', title: '选择 Provider', choices: providerChoices(ctx), allowFreeform: true, placeholder: 'provider' };
    }

    case 'apikey': {
      // step 0: provider · step 1: the key
      if (prior.length === 0) {
        return { kind: 'choice', title: '为哪个 Provider 配置 API Key', choices: providerChoices(ctx), allowFreeform: true, placeholder: 'provider' };
      }
      if (prior.length === 1) {
        return { kind: 'freeform', title: `粘贴 ${prior[0]} 的 API Key`, choices: [], allowFreeform: true, placeholder: 'sk-…（回车保存）', secret: true };
      }
      return null;
    }

    case 'resume': {
      if (prior.length >= 1) return null;
      const choices: ArgChoice[] = ctx.sessions.map((s, i) => ({ value: String(i + 1), label: `${i + 1}. ${s.label}`, hint: s.id.slice(0, 8) }));
      return { kind: 'choice', title: choices.length ? '选择要恢复的会话' : '暂无历史会话', choices, allowFreeform: true, placeholder: '序号或 id' };
    }
  }
  return null;
}

/** Assemble the final command line from the base command + chosen values. */
export function buildCommandLine(command: string, values: string[]): string {
  const cmd = command.replace(/^\//, '').trim().toLowerCase();
  const v = values.filter((x) => x !== undefined && x !== null);
  switch (cmd) {
    case 'apikey':
      // /apikey set <provider> <key>
      return `/apikey set ${v.join(' ')}`.trim();
    case 'model':
      return `/model ${v.join(' ')}`.trim();
    case 'connect':
      return `/connect ${v.join(' ')}`.trim();
    case 'resume':
      return `/resume ${v.join(' ')}`.trim();
    default:
      return `/${cmd} ${v.join(' ')}`.trim();
  }
}

/**
 * Filter + rank choices by a typed query (case-insensitive substring on value,
 * label, and group). Empty query returns the list unchanged. Exact value/label
 * prefix matches sort first so the obvious pick lands at the top.
 */
export function filterChoices(choices: ArgChoice[], typed: string): ArgChoice[] {
  const q = typed.trim().toLowerCase();
  if (!q) return choices;
  const scored: Array<{ c: ArgChoice; rank: number }> = [];
  for (const c of choices) {
    const value = c.value.toLowerCase();
    const label = c.label.toLowerCase();
    const group = (c.group || '').toLowerCase();
    let rank = -1;
    if (value === q || label === q) rank = 0;
    else if (value.startsWith(q) || label.startsWith(q)) rank = 1;
    else if (value.includes(q) || label.includes(q)) rank = 2;
    else if (group.includes(q)) rank = 3;
    if (rank >= 0) scored.push({ c, rank });
  }
  scored.sort((a, b) => a.rank - b.rank); // stable within equal ranks
  return scored.map((s) => s.c);
}
