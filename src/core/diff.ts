/**
 * Minimal line-based unified diff for edit previews.
 *
 * Edits applied by edit_file are localized (a contiguous region changes), so a
 * single trimmed hunk — common prefix/suffix removed, the differing middle
 * shown with a few lines of context — is enough to let the model and the user
 * see exactly what changed without diffing whole files line-by-line.
 */

export interface DiffOptions {
  /** Lines of unchanged context around the change (default 3). */
  context?: number;
  /** Optional path shown in the diff header. */
  path?: string;
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** Result of rendering a diff: the text plus +/- line counts. */
export interface DiffResult {
  text: string;
  stat: DiffStat;
}

function commonPrefixLen(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string[], b: string[], skip: number): number {
  const max = Math.min(a.length, b.length) - skip;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Produce a compact unified diff between two strings. Returns the diff text and
 * a +/- line stat. Identical inputs yield an empty diff (stat 0/0).
 */
export function unifiedDiff(oldStr: string, newStr: string, opts: DiffOptions = {}): DiffResult {
  if (oldStr === newStr) return { text: '', stat: { added: 0, removed: 0 } };

  const context = Math.max(0, opts.context ?? 3);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  let pre = commonPrefixLen(oldLines, newLines);
  const suf = commonSuffixLen(oldLines, newLines, pre);

  // The changed region (exclusive of the common prefix/suffix).
  const oldChanged = oldLines.slice(pre, oldLines.length - suf);
  const newChanged = newLines.slice(pre, newLines.length - suf);

  // Context window bounds.
  const ctxStart = Math.max(0, pre - context);
  const oldCtxAfterStart = oldLines.length - suf;
  const oldCtxAfter = oldLines.slice(oldCtxAfterStart, oldCtxAfterStart + context);
  const leading = oldLines.slice(ctxStart, pre);

  const lines: string[] = [];
  if (opts.path) lines.push(`--- ${opts.path}`, `+++ ${opts.path}`);

  // Hunk header (1-based line numbers).
  const oldStart = ctxStart + 1;
  const oldCount = leading.length + oldChanged.length + oldCtxAfter.length;
  const newStart = ctxStart + 1;
  const newCount = leading.length + newChanged.length + oldCtxAfter.length;
  lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

  for (const l of leading) lines.push(` ${l}`);
  for (const l of oldChanged) lines.push(`-${l}`);
  for (const l of newChanged) lines.push(`+${l}`);
  for (const l of oldCtxAfter) lines.push(` ${l}`);

  return {
    text: lines.join('\n'),
    stat: { added: newChanged.length, removed: oldChanged.length },
  };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
