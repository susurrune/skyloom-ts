/**
 * 自定义斜杠命令 — markdown prompt templates promoted to commands.
 *
 * Drop a .md file into `.sky/commands/` (project) or `~/.skyloom/commands/`
 * (user); the filename becomes the command. Subdirectories namespace:
 * `.sky/commands/git/commit.md` → /git:commit.
 *
 * File format:
 *   ---
 *   description: 修复指定的 GitHub issue       (optional, shown in palette)
 *   agent: rain                                (optional, runs as this agent)
 *   ---
 *   请修复 issue #$ARGUMENTS：
 *   1. 读取 issue 详情 …
 *
 * Placeholders: $ARGUMENTS = everything after the command; $1…$9 = positional.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface CustomCommand {
  /** Command name without the leading slash (may contain ':'). */
  name: string;
  description: string;
  agent?: string;
  body: string;
  file: string;
}

const MAX_BODY_CHARS = 12000;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

function scanDir(dir: string, prefix: string, out: CustomCommand[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanDir(full, prefix ? `${prefix}:${e.name}` : e.name, out);
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(full, 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      const base = e.name.slice(0, -3);
      const name = prefix ? `${prefix}:${base}` : base;
      out.push({
        name,
        description: meta.description || body.trim().split('\n')[0].slice(0, 50),
        agent: meta.agent,
        body: body.trim().slice(0, MAX_BODY_CHARS),
        file: full,
      });
    } catch { /* unreadable file: skip */ }
  }
}

/**
 * Load custom commands. Project commands shadow user commands of the same
 * name. Re-scans on every call so edits take effect without a restart.
 */
export function loadCustomCommands(cwd: string = process.cwd()): CustomCommand[] {
  const user: CustomCommand[] = [];
  const project: CustomCommand[] = [];
  scanDir(path.join(os.homedir(), '.skyloom', 'commands'), '', user);
  scanDir(path.join(cwd, '.sky', 'commands'), '', project);
  const byName = new Map<string, CustomCommand>();
  for (const c of [...user, ...project]) byName.set(c.name, c); // project wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitute $ARGUMENTS and $1…$9 into a command body. */
export function substituteArgs(body: string, argString: string): string {
  const args = argString.trim() ? argString.trim().split(/\s+/) : [];
  return body
    .replace(/\$ARGUMENTS/g, argString.trim())
    .replace(/\$([1-9])/g, (_, n) => args[parseInt(n, 10) - 1] ?? '');
}

/**
 * Match an input line like "/fix-issue 123" against the loaded commands.
 * Returns the expanded prompt (and optional agent) or null.
 */
export function resolveCustomCommand(
  input: string,
  commands: CustomCommand[]
): { command: CustomCommand; prompt: string } | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = (space < 0 ? input.slice(1) : input.slice(1, space)).toLowerCase();
  const argString = space < 0 ? '' : input.slice(space + 1);
  const command = commands.find(c => c.name.toLowerCase() === name);
  if (!command) return null;
  return { command, prompt: substituteArgs(command.body, argString) };
}
