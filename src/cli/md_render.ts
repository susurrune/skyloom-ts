/**
 * Lightweight terminal markdown styler for the streaming TUI.
 *
 * The loom re-renders each frame from the full accumulated `b.text`, so we can
 * style the *displayed* text every frame without worrying about partial
 * tokens (`**` arriving in pieces) — the next frame just re-applies the regex
 * against the full text.
 *
 * Order matters:
 *   1. wrap the RAW text at terminal width (visual width math doesn't see ANSI)
 *   2. THEN apply per-line markdown styling (no styling spans line breaks here)
 *
 * Block-level (headings / bullets / hr) is detected on the *original* line
 * before wrapping is applied to its continuation, so the indent stays right.
 *
 * Inline rules are conservative: bold (** **), italic (* *  / _ _), inline
 * code (` `), strikethrough (~~ ~~). We avoid touching anything that looks
 * unsafe (e.g. code inside ``` fences) — the streaming model can produce
 * partial syntax mid-frame, but a partial match just won't style and will
 * resolve on the next frame.
 */

import chalk from "chalk";

/** Preserve original character offsets so wrapping math stays correct. */
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;

/** Apply inline markdown styling to a single, already-wrapped line. */
export function styleInline(line: string): string {
  // Inline code FIRST — its content must not be re-styled
  // (otherwise `*x*` inside backticks would render italic).
  let out = line.replace(/`([^`\n]+?)`/g, (_, c) => chalk.cyan(c));

  // Bold (**x** or __x__) — non-greedy, no inner newlines.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_, c) => chalk.bold(c));
  out = out.replace(/__([^_\n]+?)__/g, (_, c) => chalk.bold(c));

  // Italic — single * / _, but not part of a leftover `**`/`__` boundary.
  out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, (_, pre, c) => `${pre}${chalk.italic(c)}`);
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, (_, pre, c) => `${pre}${chalk.italic(c)}`);

  // Strikethrough.
  out = out.replace(/~~([^~\n]+?)~~/g, (_, c) => chalk.strikethrough(c));

  return out;
}

/**
 * Style a full block of text (already wrapped to width) for terminal display.
 * `inCodeFence` is threaded across calls so streaming code blocks stay raw.
 */
export interface RenderState { inCodeFence: boolean; }

export function newRenderState(): RenderState { return { inCodeFence: false }; }

/**
 * Render one logical line (no internal newlines) for the terminal.
 * The caller is responsible for wrapping; we don't reflow.
 */
export function styleLine(line: string, state: RenderState): string {
  if (FENCE_RE.test(line)) {
    state.inCodeFence = !state.inCodeFence;
    return chalk.dim(line); // show the fence itself dimmed
  }
  if (state.inCodeFence) return chalk.cyan(line); // raw, monochrome code

  if (HR_RE.test(line)) return chalk.dim("─".repeat(Math.max(3, line.trim().length)));

  let m = line.match(HEADING_RE);
  if (m) {
    const level = m[1].length;
    const text = styleInline(m[2]);
    if (level === 1) return chalk.bold.underline(text);
    if (level === 2) return chalk.bold(text);
    return chalk.bold.dim(text);
  }

  m = line.match(BLOCKQUOTE_RE);
  if (m) return chalk.dim("│ ") + chalk.dim(styleInline(m[1]));

  m = line.match(UL_RE);
  if (m) return `${m[1]}${chalk.dim("•")} ${styleInline(m[2])}`;

  m = line.match(OL_RE);
  if (m) return `${m[1]}${chalk.dim(m[2] + ".")} ${styleInline(m[3])}`;

  return styleInline(line);
}

/**
 * Style a multi-line block of text (typically the output of a wrapper). Each
 * line is treated as a logical line; inline code-fence state carries across.
 */
export function styleBlock(text: string): string {
  const state = newRenderState();
  return text.split("\n").map((l) => styleLine(l, state)).join("\n");
}
