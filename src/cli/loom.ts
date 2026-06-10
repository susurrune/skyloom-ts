/**
 * 天空织机 · 立轴 — the full-screen ink-wash weather-station TUI.
 *
 * Architecture notes (why this one works where the old full-screen attempt
 * failed):
 *   1. Streamed text never touches the terminal directly. It lands in a
 *      virtual block buffer; every frame is composed in memory and a diff
 *      renderer repaints only the rows that changed. Streaming and animation
 *      therefore cannot fight over the cursor.
 *   2. All width math goes through the CJK-aware helpers in tui.ts, so the
 *      hand-rolled input editor cannot mangle fullwidth glyphs.
 *   3. The animation clock is the single writer: key events and stream events
 *      only mutate state; the frame timer (and explicit repaint requests)
 *      flush it.
 *
 * Layout (画轴 / hanging scroll):
 *   ┌─ 天空织机 ───────────────────────────── ▣ 霧 ─┐   header + seal
 *   │  ≋      ❉        ⸽      particles / shuttles │   sky band (2 rows)
 *   │ ▁▂▃▅▃▂▁▁▂▄▂▁  mountain grows with the session │
 *   │ ● 霧 fog   │  conversation viewport            │   rail │ viewport
 *   │ · 雨 rain  │  …                                │
 *   ├─ 思忖 ··· ──────────────── model · cost · ctx ─┤   status divider
 *   │ ≋ ❯ input                                      │   input line
 *   └─ /help · Tab 补全 · PgUp 翻页 ─────────────────┘
 *
 * Design rationale: docs/AESTHETIC_DESIGN.md §2.2 (方案三 · 立轴).
 */

import * as readline from "readline";
import chalk from "chalk";
import { agentTheme, AGENT_ORDER, PALETTE } from "../core/theme";
import { charWidth, visualWidth, SLASH_COMMANDS } from "./tui";

/* ════════════════════════════════════════
   ANSI-aware string helpers (pure, tested)
   ════════════════════════════════════════ */

const ESC = "\x1b";
const ANSI_RE = /\x1b\[[0-9;]*m/;

/** Truncate a styled string to a visual width, keeping ANSI sequences intact. */
export function cutVisual(s: string, maxW: number): string {
  let out = "";
  let w = 0;
  let i = 0;
  let cut = false;
  while (i < s.length) {
    if (s[i] === ESC) {
      const m = ANSI_RE.exec(s.slice(i));
      if (m && m.index === 0) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > maxW) { cut = true; break; }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return cut ? out + "\x1b[0m" : out;
}

/** Pad a styled string with spaces to an exact visual width (truncates if over). */
export function padAnsi(s: string, w: number): string {
  const cutS = visualWidth(s) > w ? cutVisual(s, w) : s;
  const diff = w - visualWidth(cutS);
  return diff > 0 ? cutS + " ".repeat(diff) : cutS;
}

/** CJK-aware plain-text word wrap (latin wraps on spaces, CJK per glyph). */
export function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  if (width < 4) width = 4;
  for (const raw of text.split("\n")) {
    let line = "";
    let col = 0;
    let word = "";
    const flushWord = () => {
      if (!word) return;
      const w = visualWidth(word);
      if (col > 0 && col + w > width) { lines.push(line.trimEnd()); line = ""; col = 0; }
      // hard-break monster tokens (plain glyph slicing — no ANSI involved)
      while (visualWidth(word) > width) {
        let head = "", hw = 0, i = 0;
        for (const ch of word) {
          const cw = charWidth(ch.codePointAt(0)!);
          if (hw + cw > width - col) break;
          head += ch; hw += cw; i += ch.length;
        }
        lines.push(line + head);
        word = word.slice(i);
        line = ""; col = 0;
      }
      line += word; col += visualWidth(word); word = "";
    };
    for (const ch of raw) {
      const cp = ch.codePointAt(0)!;
      if (ch === " " || ch === "\t") {
        flushWord();
        if (col > 0 && col < width) { line += " "; col += 1; }
        continue;
      }
      if (charWidth(cp) === 2) {
        flushWord();
        if (col + 2 > width) { lines.push(line.trimEnd()); line = ""; col = 0; }
        line += ch; col += 2;
        continue;
      }
      word += ch;
    }
    flushWord();
    lines.push(line);
  }
  // trim trailing blank produced by terminal newline at very end
  while (lines.length > 1 && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
  return lines;
}

/* ════════════════════════════════════════
   Screen — double-buffered diff renderer
   ════════════════════════════════════════ */

export interface OutLike {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  write(s: string): boolean;
}

/** Repaints only rows whose content changed since the previous frame. */
export class Screen {
  private prev: string[] = [];
  constructor(private out: OutLike) {}

  /** Force the next flush to repaint everything (resize / resume). */
  invalidate() { this.prev = []; }

  flush(rows: string[], cursor: { row: number; col: number } | null) {
    let seq = "\x1b[?25l"; // hide cursor while painting
    for (let i = 0; i < rows.length; i++) {
      if (this.prev[i] !== rows[i]) {
        seq += `\x1b[${i + 1};1H\x1b[2K` + rows[i];
      }
    }
    if (this.prev.length > rows.length) {
      for (let i = rows.length; i < this.prev.length; i++) seq += `\x1b[${i + 1};1H\x1b[2K`;
    }
    if (cursor) seq += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    this.out.write(seq);
    this.prev = rows.slice();
  }
}

/* ════════════════════════════════════════
   Sky band — weather particles & loom shuttles
   ════════════════════════════════════════ */

interface Particle { x: number; y: number; phase: number }

/** Per-agent weather motion over a w×2 field. drift/fall/glint/float/bead/rise. */
export class SkyField {
  particles: Particle[] = [];
  private w = 0;
  constructor(private readonly h: number = 2) {}

  resize(w: number) {
    this.w = Math.max(8, w);
    const n = Math.max(3, Math.floor(this.w / 7));
    this.particles = Array.from({ length: n }, (_, i) => ({
      x: (i * 7.3 + (i * i % 5)) % this.w,
      y: (i * 13) % this.h,
      phase: (i * 37) % 17,
    }));
  }

  step(motion: string, tick: number) {
    for (const p of this.particles) {
      switch (motion) {
        case "drift": p.x += 0.45; p.y = (Math.sin((tick + p.phase) / 6) > 0 ? 0 : 1); break;
        case "fall": p.y += 0.55; p.x += 0.12; break;
        case "glint": /* static, blink via phase at render */ break;
        case "float": p.y += 0.28; p.x += Math.sin((tick + p.phase) / 4) * 0.5; break;
        case "bead": /* static, brightness breathes */ break;
        case "rise": p.y -= 0.3; break;
      }
      if (p.x >= this.w) p.x -= this.w;
      if (p.x < 0) p.x += this.w;
      if (p.y >= this.h) p.y -= this.h;
      if (p.y < 0) p.y += this.h;
    }
  }

  /** Render the two sky rows. Shuttles (orchestration) overlay the weather. */
  render(
    w: number,
    motion: string,
    symbol: string,
    hex: string,
    tick: number,
    shuttles: { symbol: string; hex: string; x: number; row: number }[],
  ): string[] {
    if (w !== this.w) this.resize(w);
    const grid: { ch: string; style: (s: string) => string }[][] = Array.from(
      { length: this.h },
      () => Array.from({ length: w }, () => ({ ch: " ", style: (s: string) => s })),
    );
    const pigment = chalk.hex(hex);
    for (const p of this.particles) {
      const visible = motion === "glint" ? Math.sin((tick + p.phase) / 3) > -0.2 : true;
      if (!visible) continue;
      const dimmed = motion === "bead" ? Math.sin((tick + p.phase) / 5) < 0 : (p.phase % 3 === 0);
      const x = Math.min(w - 1, Math.round(p.x));
      const y = Math.min(this.h - 1, Math.round(p.y));
      grid[y][x] = { ch: symbol, style: dimmed ? (s) => pigment.dim(s) : (s) => pigment(s) };
    }
    // Loom shuttles: a thread of ┄ in the agent's pigment, shuttle glyph at the head.
    for (const sh of shuttles) {
      const row = sh.row % this.h;
      const head = Math.round(sh.x) % w;
      const thread = chalk.hex(sh.hex).dim;
      for (let x = 0; x < head; x++) if (grid[row][x].ch === " ") grid[row][x] = { ch: "┄", style: thread };
      grid[row][head] = { ch: sh.symbol, style: chalk.hex(sh.hex).bold };
    }
    return grid.map((cells) => {
      let line = "";
      for (const c of cells) line += c.ch === " " ? " " : c.style(c.ch);
      return line;
    });
  }
}

/** Distant-mountain silhouette; grows slowly as the session lengthens. */
export function mountainRow(width: number, turns: number): string {
  const GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅"];
  const growth = Math.min(1, turns / 30) * 0.7 + 0.3;
  let out = "";
  for (let x = 0; x < width; x++) {
    // layered sines make a credible ridge; deterministic, so the diff renderer
    // only repaints this row when `turns` changes.
    const r = Math.sin(x / 6.1) * 0.5 + Math.sin(x / 13.7 + 2) * 0.35 + Math.sin(x / 3.3 + 5) * 0.15;
    const h = Math.max(0, Math.round((r * 0.5 + 0.5) * (GLYPHS.length - 1) * growth));
    out += GLYPHS[h];
  }
  return chalk.hex(PALETTE.inkFaint).dim(out);
}

/* ════════════════════════════════════════
   Viewport blocks
   ════════════════════════════════════════ */

/**
 * "text" blocks hold plain text, wrapped CJK-aware at render time, styled
 * per line. "line" blocks are pre-styled single lines (tasks, tool events)
 * that are truncated rather than wrapped, and may be updated in place by id.
 */
export interface Block {
  kind: "text" | "line" | "blank";
  text: string;
  /** style applied to each wrapped line of a "text" block */
  style?: (s: string) => string;
  /** left gutter prefix for "text" blocks (first line only) */
  head?: string;
  id?: string;
  /** the open block receives stream writes + ink-bleed cursor */
  open?: boolean;
  version: number;
  cache?: { width: number; version: number; lines: string[] };
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function circled(i: number): string { return CIRCLED[i] ?? `(${i + 1})`; }

/* ════════════════════════════════════════
   Orchestration state (multi-agent dynamics)
   ════════════════════════════════════════ */

export interface OrchTask {
  id: string;
  index: number;
  agent: string;
  desc: string;
  deps: string[];
  state: "wait" | "run" | "ok" | "fail";
  startedAt?: number;
  ms?: number;
}

export class OrchState {
  tasks = new Map<string, OrchTask>();
  order: string[] = [];
  active = false;
  /** moving shuttle x-position per running agent */
  shuttleX = new Map<string, number>();

  plan(raw: any[]) {
    this.active = true;
    for (const t of raw) {
      if (this.tasks.has(t.id)) continue;
      this.tasks.set(t.id, {
        id: t.id,
        index: this.order.length,
        agent: t.assignedTo || "fog",
        desc: String(t.description || "").split("\n")[0],
        deps: (t.allDeps || []).slice(),
        state: "wait",
      });
      this.order.push(t.id);
    }
  }

  start(id: string) {
    const t = this.tasks.get(id);
    if (t) { t.state = "run"; t.startedAt = Date.now(); this.shuttleX.set(t.agent, 0); }
  }

  done(id: string, ok: boolean) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.state = ok ? "ok" : "fail";
    t.ms = t.startedAt ? Date.now() - t.startedAt : undefined;
    if (![...this.tasks.values()].some((x) => x.state === "run" && x.agent === t.agent)) {
      this.shuttleX.delete(t.agent);
    }
  }

  finish() { this.active = false; this.shuttleX.clear(); }

  runningAgents(): string[] {
    return [...new Set([...this.tasks.values()].filter((t) => t.state === "run").map((t) => t.agent))];
  }

  /** Per-agent ✓/✗ tally for the rail. */
  tally(agent: string): { ok: number; fail: number; run: boolean } {
    let ok = 0, fail = 0, run = false;
    for (const t of this.tasks.values()) {
      if (t.agent !== agent) continue;
      if (t.state === "ok") ok++;
      else if (t.state === "fail") fail++;
      else if (t.state === "run") run = true;
    }
    return { ok, fail, run };
  }

  progress(): { done: number; total: number } {
    let done = 0;
    for (const t of this.tasks.values()) if (t.state === "ok" || t.state === "fail") done++;
    return { done, total: this.tasks.size };
  }
}

/* ════════════════════════════════════════
   LoomUI — the hanging-scroll interface
   ════════════════════════════════════════ */

export interface LoomOpts {
  out?: OutLike;
  inp?: NodeJS.ReadStream | null;
  /** disable timers/raw-mode for tests */
  headless?: boolean;
}

const RAIL_W = 15; // visual columns of the left rail (inside borders)
const SKY_H = 2;

export class LoomUI {
  private out: OutLike;
  private inp: NodeJS.ReadStream | null;
  private screen: Screen;
  private sky = new SkyField(SKY_H);
  private blocks: Block[] = [];
  private byId = new Map<string, Block>();
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private headless: boolean;
  private destroyed = false;

  agentName = "fog";
  turns = 0;
  busy = false;
  busyLabel = "";
  orch = new OrchState();

  /** status providers (wired by the chat loop) */
  statusRight: () => string = () => "";

  // input editor state
  private inputGlyphs: string[] = []; // glyphs
  private cursor = 0;
  private history: string[] = [];
  private histIdx = -1;
  private histStash = "";
  private scrollOff = 0; // 0 = follow tail
  private paletteIdx = 0;
  private pendingResolve: ((s: string) => void) | null = null;
  private modal: { text: string; resolve: (ok: boolean) => void } | null = null;
  private sigintAt = 0;
  onInterrupt: (() => void) | null = null;
  /** Shift+Tab cycles interactive modes (default/plan/auto); wired by the chat loop. */
  onModeCycle: (() => void) | null = null;
  /** Styled mode badge shown in the status divider when idle ('' = default). */
  modeBadge = "";
  private keypressHandler: ((str: string, key: any) => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(opts?: LoomOpts) {
    this.out = opts?.out ?? (process.stdout as OutLike);
    this.inp = opts?.inp === undefined ? process.stdin : opts.inp;
    this.headless = opts?.headless ?? false;
    this.screen = new Screen(this.out);
  }

  /* ── lifecycle ── */

  start() {
    if (!this.headless) {
      this.out.write("\x1b[?1049h\x1b[2J"); // alternate screen
      if (this.inp && this.inp.isTTY) {
        readline.emitKeypressEvents(this.inp);
        this.inp.setRawMode(true);
        this.inp.resume();
        this.keypressHandler = (str, key) => this.onKey(str, key);
        this.inp.on("keypress", this.keypressHandler);
      }
      this.resizeHandler = () => { this.screen.invalidate(); this.invalidateWraps(); this.paint(); };
      (process.stdout as any).on?.("resize", this.resizeHandler);
      this.timer = setInterval(() => this.frame(), 120);
    }
    this.paint();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.inp && this.keypressHandler) this.inp.removeListener("keypress", this.keypressHandler);
    if (this.resizeHandler) (process.stdout as any).removeListener?.("resize", this.resizeHandler);
    if (!this.headless) {
      if (this.inp && this.inp.isTTY) this.inp.setRawMode(false);
      this.out.write("\x1b[?1049l\x1b[?25h");
    }
  }

  /** Temporarily leave the loom (setup wizard etc.), then restore. */
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inp && this.inp.isTTY) this.inp.setRawMode(false);
    if (this.inp && this.keypressHandler) this.inp.removeListener("keypress", this.keypressHandler);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.out.write("\x1b[?1049l\x1b[?25h");
    try {
      return await fn();
    } finally {
      this.out.write("\x1b[?1049h\x1b[2J");
      if (this.inp && this.inp.isTTY) {
        this.inp.setRawMode(true);
        this.inp.resume();
        if (this.keypressHandler) this.inp.on("keypress", this.keypressHandler);
      }
      this.screen.invalidate();
      if (!this.headless) this.timer = setInterval(() => this.frame(), 120);
      this.paint();
    }
  }

  /* ── block API ── */

  private push(b: Omit<Block, "version">): Block {
    const blk: Block = { version: 0, ...b };
    this.blocks.push(blk);
    if (blk.id) this.byId.set(blk.id, blk);
    if (this.blocks.length > 3000) {
      const drop = this.blocks.splice(0, 500);
      for (const d of drop) if (d.id) this.byId.delete(d.id);
    }
    this.scrollOff = 0; // new content snaps to tail
    return blk;
  }

  blank() { this.push({ kind: "blank", text: "" }); }

  /** Pre-styled single line (truncated, never wrapped). */
  line(text: string, id?: string) {
    if (id && this.byId.has(id)) { this.update(id, text); return; }
    this.push({ kind: "line", text, id });
  }

  update(id: string, text: string) {
    const b = this.byId.get(id);
    if (b && b.text !== text) { b.text = text; b.version++; }
  }

  /** Wrapped plain-text block. */
  text(text: string, style?: (s: string) => string, head?: string) {
    this.push({ kind: "text", text, style, head });
  }

  /* ── streaming ── */

  private openBlock: Block | null = null;
  private bleedLen = 0;

  beginStream(agentName: string) {
    const t = agentTheme(agentName);
    this.blank();
    this.line(chalk.bold.hex(t.hex)(`${t.symbol} ${t.kanji} `) + chalk.hex(t.hex)(t.name));
    this.blank();
    this.openBlock = this.push({ kind: "text", text: "", open: true });
    this.bleedLen = 0;
  }

  /** Re-open a fresh stream block (after a tool event), without the header. */
  continueStream() {
    this.endStream();
    this.openBlock = this.push({ kind: "text", text: "", open: true });
    this.bleedLen = 0;
  }

  streamWrite(s: string) {
    if (!this.openBlock) this.beginStream(this.agentName);
    const b = this.openBlock!;
    b.text += s.replace(/\r/g, "");
    b.version++;
    this.bleedLen = Math.min(12, this.bleedLen + [...s].length);
  }

  endStream() {
    if (this.openBlock) { this.openBlock.open = false; this.openBlock.version++; this.openBlock = null; }
    this.bleedLen = 0;
  }

  clearViewport() { this.blocks = []; this.byId.clear(); this.scrollOff = 0; this.viewportCache = null; this.paint(); }

  /** Transient hint in the status divider. */
  flash(msg: string, ms = 1600) {
    this.flashHint = msg;
    this.paint();
    setTimeout(() => { if (this.flashHint === msg) { this.flashHint = ""; this.paint(); } }, ms);
  }

  /* ── input ── */

  /** Read one submitted line (the editor stays live during streaming). */
  readInput(): Promise<string> {
    return new Promise((resolve) => { this.pendingResolve = resolve; });
  }

  /** Modal y/N confirmation (tool approval). */
  confirm(text: string): Promise<boolean> {
    return new Promise((resolve) => { this.modal = { text, resolve }; this.paint(); });
  }

  setHistory(h: string[]) { this.history = h.slice(); }

  private onKey(str: string, key: any) {
    if (this.destroyed) return;
    if (this.modal) {
      const k = (str || "").toLowerCase();
      if (k === "y") { const m = this.modal; this.modal = null; m.resolve(true); }
      else if (k === "n" || key?.name === "return" || key?.name === "escape") {
        const m = this.modal; this.modal = null; m.resolve(false);
      }
      this.paint();
      return;
    }

    const name = key?.name;
    if (key?.ctrl && name === "c") { this.handleSigint(); return; }

    if (name === "pageup") { this.scrollOff += Math.max(1, this.bodyH() - 2); this.clampScroll(); this.paint(); return; }
    if (name === "pagedown") { this.scrollOff -= Math.max(1, this.bodyH() - 2); this.clampScroll(); this.paint(); return; }

    if (name === "return") {
      if (this.busy) return; // a reply is being woven; ignore submit
      const text = this.inputGlyphs.join("").trim();
      this.inputGlyphs = []; this.cursor = 0; this.histIdx = -1; this.paletteIdx = 0;
      if (text) { this.history.unshift(text); if (this.history.length > 200) this.history.pop(); }
      const r = this.pendingResolve;
      this.pendingResolve = null;
      this.paint();
      if (r) r(text);
      return;
    }

    const paletteOpen = this.paletteMatches().length > 0 && this.inputGlyphs[0] === "/";

    if (name === "up") {
      if (paletteOpen) { this.paletteIdx = Math.max(0, this.paletteIdx - 1); }
      else if (this.histIdx < this.history.length - 1) {
        if (this.histIdx === -1) this.histStash = this.inputGlyphs.join("");
        this.histIdx++;
        this.inputGlyphs = [...this.history[this.histIdx]]; this.cursor = this.inputGlyphs.length;
      }
      this.paint(); return;
    }
    if (name === "down") {
      if (paletteOpen) { this.paletteIdx = Math.min(this.paletteMatches().length - 1, this.paletteIdx + 1); }
      else if (this.histIdx >= 0) {
        this.histIdx--;
        this.inputGlyphs = [...(this.histIdx === -1 ? this.histStash : this.history[this.histIdx])];
        this.cursor = this.inputGlyphs.length;
      }
      this.paint(); return;
    }
    if (name === "tab" && key?.shift) { this.onModeCycle?.(); this.paint(); return; }
    if (name === "tab") {
      if (paletteOpen) {
        const m = this.paletteMatches();
        const pick = m[Math.min(this.paletteIdx, m.length - 1)];
        if (pick) { this.inputGlyphs = [...pick[0].trimEnd()]; this.cursor = this.inputGlyphs.length; }
      }
      this.paint(); return;
    }
    if (name === "escape") { this.paletteIdx = 0; this.scrollOff = 0; this.paint(); return; }
    if (name === "backspace") {
      if (this.cursor > 0) { this.inputGlyphs.splice(this.cursor - 1, 1); this.cursor--; }
      this.paint(); return;
    }
    if (name === "delete") { if (this.cursor < this.inputGlyphs.length) this.inputGlyphs.splice(this.cursor, 1); this.paint(); return; }
    if (name === "left") { if (this.cursor > 0) this.cursor--; this.paint(); return; }
    if (name === "right") { if (this.cursor < this.inputGlyphs.length) this.cursor++; this.paint(); return; }
    if (key?.ctrl && name === "a") { this.cursor = 0; this.paint(); return; }
    if (key?.ctrl && name === "e") { this.cursor = this.inputGlyphs.length; this.paint(); return; }
    if (key?.ctrl && name === "u") { this.inputGlyphs.splice(0, this.cursor); this.cursor = 0; this.paint(); return; }
    if (key?.ctrl && name === "w") {
      let i = this.cursor;
      while (i > 0 && this.inputGlyphs[i - 1] === " ") i--;
      while (i > 0 && this.inputGlyphs[i - 1] !== " ") i--;
      this.inputGlyphs.splice(i, this.cursor - i); this.cursor = i;
      this.paint(); return;
    }
    if (key?.ctrl && name === "l") { this.clearViewport(); return; }

    if (str && !key?.ctrl && !key?.meta) {
      const glyphs = [...str].filter((c) => c >= " " || charWidth(c.codePointAt(0)!) > 0);
      if (glyphs.length) {
        this.inputGlyphs.splice(this.cursor, 0, ...glyphs);
        this.cursor += glyphs.length;
        this.histIdx = -1;
        this.paint();
      }
    }
  }

  private handleSigint() {
    const now = Date.now();
    if (this.busy && this.onInterrupt) {
      this.onInterrupt();
      return;
    }
    if (now - this.sigintAt < 1500) {
      this.destroy();
      process.stdout.write(chalk.dim("  再会。\n"));
      process.exit(0);
    }
    this.sigintAt = now;
    this.flash("再按一次 Ctrl-C 退出");
  }

  private flashHint = "";

  private paletteMatches(): [string, string][] {
    const l = this.inputGlyphs.join("");
    if (!l.startsWith("/") || l.includes(" ")) return [];
    return SLASH_COMMANDS.filter(([c]) => c.trimEnd().startsWith(l));
  }

  /* ── geometry ── */

  private cols(): number { return Math.max(40, this.out.columns || 80); }
  private rows(): number { return Math.max(12, this.out.rows || 24); }
  // header(1) + sky(2) + body + divider(1) + input(1) + bottom(1) = rows
  private bodyH(): number { return this.rows() - SKY_H - 4; }

  private clampScroll() {
    const total = this.viewportLines().length;
    const maxOff = Math.max(0, total - this.bodyH());
    this.scrollOff = Math.max(0, Math.min(this.scrollOff, maxOff));
  }

  private invalidateWraps() { for (const b of this.blocks) b.cache = undefined; }

  /* ── frame composition ── */

  private frame() {
    this.tick++;
    const animate = this.busy || this.orch.active;
    // advance shuttles
    if (this.orch.active) {
      for (const [a, x] of this.orch.shuttleX) this.orch.shuttleX.set(a, x + 1.3);
    }
    // ink "dries": the bleed tail shrinks even when no new tokens arrive
    if (this.openBlock && this.bleedLen > 0 && this.tick % 2 === 0) this.bleedLen = Math.max(0, this.bleedLen - 2);
    if (animate || this.tick % 5 === 0) {
      const t = agentTheme(this.agentName);
      this.sky.step(t.motion, this.tick);
      this.paint();
    }
  }

  private viewportCache: { lines: string[]; key: string } | null = null;

  private viewportLines(): string[] {
    const w = this.viewW();
    // the open block's cursor pulse + bleed tail animate with the clock
    const anim = this.openBlock ? `|b${this.bleedLen}|t${this.tick & 7}` : "";
    const key = this.blocks.map((b) => b.version).join(",") + `|${w}|${this.blocks.length}` + anim;
    if (this.viewportCache && this.viewportCache.key === key) return this.viewportCache.lines;
    const lines: string[] = [];
    for (const b of this.blocks) {
      if (b.kind === "blank") { lines.push(""); continue; }
      if (b.kind === "line") { lines.push(cutVisual(b.text, w)); continue; }
      if (!b.cache || b.cache.width !== w || b.cache.version !== b.version) {
        const wrapped = wrapPlain(b.text, b.head ? w - visualWidth(b.head) : w);
        b.cache = { width: w, version: b.version, lines: wrapped };
      }
      const style = b.style ?? ((s: string) => s);
      b.cache.lines.forEach((ln, i) => {
        const head = b.head ? (i === 0 ? b.head : " ".repeat(visualWidth(b.head))) : "";
        let body = style(ln);
        if (b.open && i === b.cache!.lines.length - 1) {
          // ink-bleed: the freshest glyphs render faint, "drying" into full ink
          const glyphs = [...ln];
          const bleed = Math.min(this.bleedLen, glyphs.length);
          if (bleed > 0) {
            const headPart = glyphs.slice(0, glyphs.length - bleed).join("");
            const tailPart = glyphs.slice(glyphs.length - bleed).join("");
            body = style(headPart) + chalk.hex(PALETTE.inkLight)(tailPart);
          }
          body += this.tick % 8 < 4 ? chalk.hex(agentTheme(this.agentName).hex)("▍") : chalk.dim("▏");
        }
        lines.push(head + body);
      });
    }
    this.viewportCache = { lines, key };
    return lines;
  }

  // borders(2) + rail + rail-border(1) + gutter(1)
  private viewW(): number { return this.cols() - 2 - RAIL_W - 2; }

  private railLines(h: number): string[] {
    const out: string[] = [];
    const W = RAIL_W;
    out.push("");
    for (const name of AGENT_ORDER) {
      const t = agentTheme(name);
      const active = name === this.agentName;
      const tally = this.orch.tally(name);
      let marker: string;
      if (tally.run) marker = this.tick % 2 ? chalk.hex(t.hex)(t.symbol) : chalk.hex(t.hex).dim(t.symbol);
      else marker = active ? chalk.hex(t.hex)("●") : chalk.hex(PALETTE.inkFaint)("·");
      let badge = "";
      if (tally.ok) badge += chalk.hex("#3a7a6e")(` ✓${tally.ok}`);
      if (tally.fail) badge += chalk.hex("#b3342d")(` ✗${tally.fail}`);
      const label = active ? chalk.bold.hex(t.hex)(`${t.kanji} ${t.name}`) : chalk.hex(t.hex).dim(`${t.kanji} ${t.name}`);
      out.push(padAnsi(` ${marker} ${label}${badge}`, W));
    }
    out.push(chalk.hex(PALETTE.inkFaint)(" " + "╌".repeat(W - 2)));
    const t = agentTheme(this.agentName);
    for (const ln of wrapPlain(t.poem, W - 2).slice(0, 2)) {
      out.push(" " + chalk.hex(PALETTE.inkLight).italic(ln));
    }
    out.push(" " + chalk.hex(PALETTE.inkLight).dim(t.pigment));
    if (this.orch.active) {
      const p = this.orch.progress();
      out.push("");
      out.push(" " + chalk.hex(t.hex)(`織 ${p.done}/${p.total}`) + chalk.dim(" 梭"));
    }
    while (out.length < h) out.push("");
    return out.slice(0, h);
  }

  /** Compose and flush a frame. Returns the composed rows (used by tests). */
  paint(): string[] {
    if (this.destroyed) return [];
    const cols = this.cols();
    const rows = this.rows();
    const innerW = cols - 2;
    const t = agentTheme(this.agentName);
    const frame: string[] = [];
    const faint = chalk.hex(PALETTE.inkFaint);
    const B = (s: string) => faint(s);

    if (cols < 60 || rows < 14) {
      const small = [chalk.yellow(" 窗口太小 · 请放大终端 (≥60×14) ")];
      this.screen.flush(small, null);
      return small;
    }

    // ── header: title + seal ──
    {
      const seal = chalk.bgHex(t.hex).hex(PALETTE.paper).bold(` ${t.kanji} `);
      const title = chalk.bold(" 天空织机 ") + chalk.dim("Skyloom ");
      // ┌─ title ───…─ seal ─┐  →  2 + w(title) + fill + 4 + 2 = cols
      const fill = innerW - visualWidth(title) - 6;
      frame.push(B("┌─") + title + B("─".repeat(Math.max(0, fill))) + seal + B("─┐"));
    }

    // ── sky band ──
    {
      const shuttles = this.orch.active
        ? this.orch.runningAgents().map((a, i) => {
            const th = agentTheme(a);
            return { symbol: th.symbol, hex: th.hex, x: (this.orch.shuttleX.get(a) || 0) % innerW, row: i };
          })
        : [];
      const skyRows = this.sky.render(innerW, t.motion, t.symbol, t.hex, this.tick, shuttles);
      const mountain = mountainRow(innerW, this.turns);
      frame.push(B("│") + padAnsi(skyRows[0], innerW) + B("│"));
      // mountain sits behind the lower particle row: particles overlay where present
      frame.push(B("│") + overlay(mountain, skyRows[1], innerW) + B("│"));
    }

    // ── body: rail │ viewport ──
    const bodyH = this.bodyH();
    const rail = this.railLines(bodyH);
    const view = this.viewportLines();
    this.clampScroll();
    const start = Math.max(0, view.length - bodyH - this.scrollOff);
    const visible = view.slice(start, start + bodyH);
    for (let i = 0; i < bodyH; i++) {
      const left = padAnsi(rail[i] ?? "", RAIL_W);
      const right = padAnsi(visible[i] ?? "", this.viewW());
      frame.push(B("│") + left + B("│") + " " + right + B("│"));
    }

    // ── status divider ──
    {
      let leftLabel = "";
      if (this.modal) leftLabel = "";
      else if (this.busy && this.busyLabel) {
        const dots = ["·  ", "·· ", "···", " ··", "  ·", "   "][this.tick % 6];
        leftLabel = ` ${chalk.hex(t.hex)(t.symbol)} ${chalk.dim(this.busyLabel + " " + dots)} `;
      } else if (this.flashHint) leftLabel = " " + chalk.yellow(this.flashHint) + " ";
      else if (this.scrollOff > 0) leftLabel = " " + chalk.dim(`↑ 回看中 · Esc 回到末尾`) + " ";
      else if (this.modeBadge) leftLabel = " " + this.modeBadge + " ";
      const right = this.statusRight();
      const rightLabel = right ? ` ${right} ` : "";
      const fill = innerW - visualWidth(leftLabel) - visualWidth(rightLabel);
      frame.push(B("├") + leftLabel + B("─".repeat(Math.max(0, fill))) + rightLabel + B("┤"));
    }

    // ── palette overlay (replaces tail viewport rows visually — drawn over input-adjacent rows) ──
    // (kept simple: palette renders inside the viewport's final rows via paint order below)

    // ── input row ──
    let cursorPos: { row: number; col: number } | null = null;
    {
      let content: string;
      if (this.modal) {
        content = " " + chalk.yellow("⚠ ") + cutVisual(this.modal.text, innerW - 14) + chalk.bold(" 允许? ") + chalk.dim("[y/N]");
        cursorPos = { row: rows - 2, col: Math.min(innerW, visualWidth(content) + 1) };
      } else {
        const promptStr = chalk.hex(t.hex)(` ${t.symbol} `) + chalk.hex(PALETTE.inkLight)("❯ ");
        const promptW = visualWidth(promptStr);
        const avail = innerW - promptW - 1;
        // horizontal scroll window around the cursor
        const glyphs = this.inputGlyphs;
        let beforeW = 0;
        for (let i = 0; i < this.cursor; i++) beforeW += charWidth(glyphs[i].codePointAt(0)!);
        let startIdx = 0, skipW = 0;
        while (beforeW - skipW > avail - 2 && startIdx < glyphs.length) {
          skipW += charWidth(glyphs[startIdx].codePointAt(0)!);
          startIdx++;
        }
        let shown = "", shownW = 0, cursorCol = promptW + (beforeW - skipW);
        for (let i = startIdx; i < glyphs.length; i++) {
          const cw = charWidth(glyphs[i].codePointAt(0)!);
          if (shownW + cw > avail) break;
          shown += glyphs[i]; shownW += cw;
        }
        content = promptStr + shown;
        cursorPos = { row: rows - 2, col: 1 + cursorCol };
      }
      frame.push(B("│") + padAnsi(content, innerW) + B("│"));
    }

    // ── bottom border with hints ──
    {
      const hint = this.busy
        ? " Ctrl-C 中断本轮 "
        : " /help 命令 · Tab 补全 · PgUp 回看 · Ctrl-C 退出 ";
      // └─ hint ───…┘  →  2 + w(hint) + fill + 1 = cols
      const fill = innerW - visualWidth(hint) - 1;
      frame.push(B("└─") + chalk.dim(hint) + B("─".repeat(Math.max(0, fill)) + "┘"));
    }

    // ── slash palette: overlay onto the rows just above the divider ──
    const matches = this.paletteMatches();
    if (matches.length > 0 && this.inputGlyphs[0] === "/" && !this.modal) {
      const show = matches.slice(0, Math.min(8, bodyH - 1));
      this.paletteIdx = Math.min(this.paletteIdx, show.length - 1);
      const baseRow = 1 + SKY_H + bodyH - show.length; // first overlay row index in frame
      show.forEach(([cmd, desc], i) => {
        const sel = i === this.paletteIdx;
        const agentCmd = ["/fog", "/rain", "/frost", "/snow", "/dew", "/fair"].includes(cmd.trim());
        const color = agentCmd ? chalk.hex(agentTheme(cmd.trim().slice(1)).hex) : chalk.hex(PALETTE.inkLight);
        const mark = sel ? chalk.hex(t.hex)(" ▸ ") : "   ";
        const lineStr = mark + (sel ? chalk.bold(color(cmd.padEnd(11))) : color(cmd.padEnd(11))) + chalk.dim(cutVisual(desc, this.viewW() - 18));
        const row = baseRow + i;
        frame[row] = B("│") + padAnsi(this.railLines(bodyH)[row - 1 - SKY_H] ?? "", RAIL_W) + B("│") + " " + padAnsi(lineStr, this.viewW()) + B("│");
      });
    }

    this.screen.flush(frame, cursorPos);
    return frame;
  }
}

/** Overlay `top` onto `base` (top's non-space glyphs win), to a fixed width. */
export function overlay(base: string, top: string, width: number): string {
  // Both strings are styled; walk them in parallel by visual column.
  const cells = (s: string): string[] => {
    const out: string[] = [];
    let i = 0;
    let pending = "";
    while (i < s.length && out.length < width * 2) {
      if (s[i] === ESC) {
        const m = ANSI_RE.exec(s.slice(i));
        if (m && m.index === 0) { pending += m[0]; i += m[0].length; continue; }
      }
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const cw = charWidth(cp);
      out.push(pending + ch);
      pending = "";
      if (cw === 2) out.push(""); // wide glyph occupies two cells
      i += ch.length;
    }
    return out;
  };
  const b = cells(base);
  const t = cells(top);
  let res = "";
  for (let x = 0; x < width; x++) {
    const tc = t[x];
    const bc = b[x];
    const topVisible = tc !== undefined && tc.replace(/\x1b\[[0-9;]*m/g, "") !== " " && tc !== "";
    if (topVisible) res += tc + "\x1b[0m";
    else if (tc === "") continue; // second cell of a wide top glyph
    else if (bc !== undefined && bc !== "") res += bc + "\x1b[0m";
    else if (bc === "") continue;
    else res += " ";
  }
  return padAnsi(res, width);
}
