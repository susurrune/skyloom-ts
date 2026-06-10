/**
 * Input macros — Claude Code-style line conveniences for both CLIs:
 *
 *   @path/to/file   pull a file's content into the message (Tab-free attach)
 *   !command        run a shell command; output goes into context, no LLM turn
 *   #note           append a quick memory line to SKY.md, no LLM turn
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MAX_ATTACH_CHARS = 16000;
const MAX_ATTACH_FILES = 3;
const BANG_TIMEOUT_MS = 15_000;
const BANG_TAIL = 8000;

/** `#note` quick-memory line? (single `#` + content; `##` is markdown, skip) */
export function isHashMemory(text: string): boolean {
  return /^#(?!#)\s*\S/.test(text.trim());
}

export function hashNote(text: string): string {
  return text.trim().replace(/^#\s*/, '');
}

/** `!cmd` shell line? */
export function isBangCommand(text: string): boolean {
  return /^!\s*\S/.test(text.trim());
}

export function bangCommand(text: string): string {
  return text.trim().replace(/^!\s*/, '');
}

/** Run a `!cmd` line; returns the (tail-clamped) combined output. */
export function runBang(cmd: string, cwd: string = process.cwd()): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: BANG_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const text = out.trim() || '(无输出)';
    return { ok: true, output: text.length > BANG_TAIL ? '…' + text.slice(-BANG_TAIL) : text };
  } catch (e: any) {
    const text = `${e?.stdout || ''}${e?.stderr || ''}`.trim() || String(e?.message || e);
    return { ok: false, output: text.length > BANG_TAIL ? '…' + text.slice(-BANG_TAIL) : text };
  }
}

/**
 * Expand `@file` references: for each token that names an existing file,
 * append its (clamped) content as a fenced attachment. The original message
 * text is preserved so the model still sees what the user pointed at.
 */
export function expandFileRefs(
  text: string,
  cwd: string = process.cwd()
): { text: string; attached: string[] } {
  const attached: string[] = [];
  const refs = [...text.matchAll(/(?:^|\s)@([\w\-./\\]+)/g)].map(m => m[1]);
  if (refs.length === 0) return { text, attached };

  const sections: string[] = [];
  for (const ref of refs) {
    if (attached.length >= MAX_ATTACH_FILES) break;
    const p = path.resolve(cwd, ref);
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      let content = fs.readFileSync(p, 'utf-8');
      if (content.length > MAX_ATTACH_CHARS) content = content.slice(0, MAX_ATTACH_CHARS) + '\n…[truncated]';
      sections.push(`[附件 @${ref}]\n\`\`\`\n${content}\n\`\`\``);
      attached.push(ref);
    } catch {
      /* unreadable file: leave the reference as plain text */
    }
  }
  if (sections.length === 0) return { text, attached };
  return { text: `${text}\n\n${sections.join('\n\n')}`, attached };
}
