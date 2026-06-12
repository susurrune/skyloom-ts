/**
 * 天空织机 TUI — a polished *linear* terminal interface.
 *
 * Design note: the previous version tried to be a full-screen app, redrawing
 * the whole screen on every keystroke while the reply streamed linearly below
 * it — the two fought, the conversation never persisted, and hand-rolled
 * raw-mode editing mangled CJK width. This rewrite is linear (like Claude Code
 * / opencode): real readline line-editing + a CJK-aware wrapping stream
 * renderer. Robust, flicker-free, and it actually reads like a conversation.
 */

import * as readline from "readline";
import chalk from "chalk";
import { agentTheme, PALETTE } from "../core/theme";
import { registry } from "../core/commands";

const TUI_VERSION = (() => { try { return require("../../package.json").version; } catch { return ""; } })();

export interface TUIContext {
  agent: any;
  agents: Map<string, any>;
  model: string;
  cost: string;
  width: number;
  height: number;
}

/* ── Slash commands (for tab-completion + the inline palette) ──
   Derived from the central command registry (src/core/commands.ts) so the
   palette, tab-completer, and /help all stay in sync with a single source of
   truth — no parallel hand-kept array to drift. */
export const SLASH_COMMANDS: [string, string][] = registry.slashItems("zh");

/* ════════════════════════════════════════
   Markdown stripping — clean raw md for terminal display
   ════════════════════════════════════════ */
/** Strip common markdown formatting for clean terminal output. */
export function stripMarkdown(s: string): string {
  return s
    .replace(/^#{1,4}\s+/gm, '')           // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')         // bold
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1') // italic
    .replace(/__([^_]+)__/g, '$1')           // alt bold
    .replace(/_([^_]+)_/g, '$1')             // alt italic
    .replace(/`([^`]+)`/g, '$1')             // inline code
    .replace(/~~(.+?)~~/g, '$1')             // strikethrough
    .replace(/^\s*[-*+]\s+/gm, '• ')         // bullets
    .replace(/^\s*\d+[.)]\s+/gm, '  ')       // numbered lists
    .replace(/^\|.*\|$/gm, (line) => {       // tables → spaced columns
      return line.replace(/\|/g, '  ').replace(/-{2,}/g, '──');
    })
    .replace(/\n{3,}/g, '\n\n');             // collapse excess newlines
}

/** Page output through a simple pager (Enter to continue, q to quit) */
export async function pageOutput(out: NodeJS.WriteStream, text: string): Promise<void> {
  const lines = text.split('\n');
  const h = (out.rows || 24) - 2;
  if (lines.length <= h) { out.write(text + '\n'); return; }

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: out });

  for (let i = 0; i < lines.length; i += h) {
    const chunk = lines.slice(i, i + h).join('\n');
    out.write(chunk + '\n');
    if (i + h < lines.length) {
      const remaining = lines.length - i - h;
      out.write(`\x1b[7m  ── ${remaining} more lines · Enter=next · q=quit ── \x1b[0m\n`);
      const key: string = await new Promise(r => {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once('data', (d: Buffer) => { process.stdin.setRawMode?.(false); process.stdin.pause(); r(d.toString()); });
      });
      if (key === 'q' || key === '\x03') { rl.close(); return; }
    }
  }
  rl.close();
}

/* ════════════════════════════════════════
   CJK-aware display width
   ════════════════════════════════════════ */
/** Visual columns occupied by a single code point (CJK / fullwidth = 2). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0; // control
  // East-Asian wide / fullwidth ranges
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana…CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) // emoji / pictographs
  ) return 2;
  return 1;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visual width of a string, ignoring ANSI color codes. */
export function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += charWidth(ch.codePointAt(0) || 0);
  return w;
}

/** Pad a string (containing ANSI) to a visual width. */
export function padVisual(s: string, width: number): string {
  const diff = width - visualWidth(s);
  return diff > 0 ? s + " ".repeat(diff) : s;
}

/* ════════════════════════════════════════
   Streaming renderer — word-wrap aware, CJK aware
   ════════════════════════════════════════ */
/**
 * Writes streamed text with a fixed left gutter, wrapping at the terminal
 * width. English wraps on word boundaries; CJK wraps per glyph. Color is
 * applied per flushed chunk so styling survives wrapping.
 */
export class StreamRenderer {
  private col = 0;
  private word = "";
  private atLineStart = true;
  private out: NodeJS.WriteStream;
  private gutter: string;
  private maxCols: number;
  private color: (s: string) => string;

  constructor(out: NodeJS.WriteStream, opts?: { gutter?: string; color?: (s: string) => string }) {
    this.out = out;
    this.gutter = opts?.gutter ?? "  ";
    this.color = opts?.color ?? ((s) => s);
    const cols = out.columns || 80;
    // content width excludes the gutter; clamp for readability
    this.maxCols = Math.max(32, Math.min(cols - visualWidth(this.gutter) - 1, 96));
  }

  /** Lazily emit the left gutter at the start of each visual line. */
  private startLine() { if (this.atLineStart) { this.out.write(this.gutter); this.atLineStart = false; } }
  private newline() { this.out.write("\n"); this.atLineStart = true; this.col = 0; }

  /** Strip asterisk formatting: **text** → text, *text* → text, __text__ → text */
  private cleanWord(s: string): string {
    return s.replace(/\*\*(.+?)\*\*/g, (_, t) => t)
            .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => t)
            .replace(/__([^_]+)__/g, (_, t) => t)
            .replace(/_([^_]+)_/g, (_, t) => t);
  }

  private flushWord() {
    if (!this.word) return;
    const cleaned = this.cleanWord(this.word);
    if (!cleaned) { this.word = ""; return; }
    const w = visualWidth(cleaned);
    if (this.col > 0 && this.col + w > this.maxCols) this.newline();
    this.startLine();
    this.out.write(this.color(cleaned));
    this.col += w;
    this.word = "";
  }

  /** Feed a chunk of streamed text. Filters out raw md formatting. */
  write(text: string) {
    for (const ch of text) {
      if (ch === "\r") continue;
      if (ch === "\n") { this.flushWord(); this.newline(); continue; }
      if (ch === " " || ch === "\t") {
        this.flushWord();
        if (this.col > 0 && this.col < this.maxCols) { this.startLine(); this.out.write(" "); this.col += 1; }
        continue;
      }
      // Strip heading markers (# ## ###) at line start
      if (ch === "#" && this.atLineStart) { continue; }
      // Strip inline code backticks
      if (ch === "`") { this.flushWord(); continue; }
      const cp = ch.codePointAt(0) || 0;
      if (charWidth(cp) === 2) {
        // CJK / wide: flush any pending latin word, then place this glyph
        this.flushWord();
        if (this.col > 0 && this.col + 2 > this.maxCols) this.newline();
        this.startLine();
        this.out.write(this.color(ch));
        this.col += 2;
      } else {
        this.word += ch;
        // very long unbroken token: hard-break to avoid overflow
        if (visualWidth(this.word) >= this.maxCols) this.flushWord();
      }
    }
  }

  /** Flush any buffered word (call before switching styles / ending). */
  flush() { this.flushWord(); }
}

/* ════════════════════════════════════════
   Input — readline-based, robust line editing
   ════════════════════════════════════════ */
/** Tab-completer for slash commands. */
function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const names = SLASH_COMMANDS.map(([c]) => c.trimEnd());
  const hits = names.filter((c) => c.startsWith(line));
  return [hits.length ? hits : names, line];
}

/** The prompt string for an agent: a small mineral seal + chevron. */
export function promptFor(agentName: string): string {
  const t = agentTheme(agentName);
  return chalk.hex(t.hex)(`  ${t.symbol} ${t.kanji} `) + chalk.hex(PALETTE.inkLight)("❯ ");
}

/** Cross-turn input history (↑/↓), shared by every per-turn reader. */
const inputHistory: string[] = [];

/**
 * Read one line with the agent-themed prompt. A fresh readline interface is
 * created and closed per call — this deliberately avoids clashing with the
 * separate readline prompts used by the setup wizard and tool-approval flow
 * (two live interfaces on one stdin corrupt input). History is preserved
 * manually across turns.
 */
export function readLine(agentName: string, out: NodeJS.WriteStream = process.stdout): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: out,
      completer: slashCompleter,
      terminal: process.stdin.isTTY ?? false,
      history: [...inputHistory],
      historySize: 200,
    } as any);
    rl.on("SIGINT", () => { out.write("\n" + chalk.dim("  再会。\n")); rl.close(); process.exit(0); });
    rl.question(promptFor(agentName), (answer) => {
      const trimmed = answer.trim();
      if (trimmed) inputHistory.unshift(trimmed);
      rl.close();
      resolve(trimmed);
    });
  });
}

/** Render the inline slash-command palette (printed, not full-screen). */
export function renderPalette(filter: string): string {
  const f = filter.toLowerCase();
  const matches = SLASH_COMMANDS.filter(([c]) => c.toLowerCase().startsWith(f));
  const list = matches.length ? matches : SLASH_COMMANDS;
  const lines = list.slice(0, 12).map(([cmd, desc]) => {
    const isAgent = ["/fog", "/rain", "/frost", "/snow", "/dew", "/fair"].includes(cmd.trim());
    const name = isAgent ? chalk.hex(agentTheme(cmd.trim().slice(1)).hex)(cmd.padEnd(12)) : chalk.hex(PALETTE.inkMid)(cmd.padEnd(12));
    return "    " + name + chalk.hex(PALETTE.inkLight)(desc);
  });
  return chalk.dim("  命令 · Tab 补全\n") + lines.join("\n") + "\n";
}
