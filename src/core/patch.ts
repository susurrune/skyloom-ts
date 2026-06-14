/**
 * apply_patch — atomic, multi-file edits for larger refactors.
 *
 * Uses exact search/replace blocks (not line-number/context hunks), so it can't
 * misapply against a drifted file: every SEARCH must match the current file
 * content exactly and uniquely. The whole patch is validated first; disk is
 * only touched once every operation is known to apply — so a bad block aborts
 * the patch without leaving a half-applied tree.
 *
 * Format:
 *   *** Update File: path
 *   <<<<<<< SEARCH
 *   exact old text
 *   =======
 *   new text
 *   >>>>>>> REPLACE
 *   (one or more blocks per file)
 *
 *   *** Add File: path
 *   full file content
 *
 *   *** Delete File: path
 *
 * An optional `*** Begin Patch` / `*** End Patch` envelope is tolerated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { countOccurrences, unifiedDiff } from './diff';

export interface PatchBlock { search: string; replace: string; }
export type PatchOp =
  | { op: 'update'; path: string; blocks: PatchBlock[] }
  | { op: 'add'; path: string; content: string }
  | { op: 'delete'; path: string };

const HDR_UPDATE = /^\*\*\* Update File:\s*(.+?)\s*$/;
const HDR_ADD = /^\*\*\* Add File:\s*(.+?)\s*$/;
const HDR_DELETE = /^\*\*\* Delete File:\s*(.+?)\s*$/;
const MARK_SEARCH = '<<<<<<< SEARCH';
const MARK_SEP = '=======';
const MARK_REPLACE = '>>>>>>> REPLACE';

export function parsePatch(text: string): { ops: PatchOp[] } | { error: string } {
  const lines = text.split(/\r?\n/);
  const ops: PatchOp[] = [];
  let i = 0;

  const isHeader = (l: string) => l.startsWith('*** ');

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) { i++; continue; }
    if (line.trim() === '') { i++; continue; }

    let m: RegExpMatchArray | null;
    if ((m = line.match(HDR_UPDATE))) {
      const filePath = m[1];
      i++;
      const blocks: PatchBlock[] = [];
      while (i < lines.length && !isHeader(lines[i])) {
        if (lines[i].trim() === '') { i++; continue; }
        if (lines[i] !== MARK_SEARCH) {
          return { error: `Malformed Update block for '${filePath}': expected '${MARK_SEARCH}', got ${JSON.stringify(lines[i].slice(0, 40))}` };
        }
        i++;
        const search: string[] = [];
        while (i < lines.length && lines[i] !== MARK_SEP) search.push(lines[i++]);
        if (i >= lines.length) return { error: `Unterminated SEARCH (missing '${MARK_SEP}') for '${filePath}'` };
        i++; // consume separator
        const replace: string[] = [];
        while (i < lines.length && lines[i] !== MARK_REPLACE) replace.push(lines[i++]);
        if (i >= lines.length) return { error: `Unterminated REPLACE (missing '${MARK_REPLACE}') for '${filePath}'` };
        i++; // consume replace marker
        blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      }
      if (blocks.length === 0) return { error: `Update File '${filePath}' has no SEARCH/REPLACE blocks` };
      ops.push({ op: 'update', path: filePath, blocks });
    } else if ((m = line.match(HDR_ADD))) {
      const filePath = m[1];
      i++;
      const content: string[] = [];
      while (i < lines.length && !isHeader(lines[i])) content.push(lines[i++]);
      while (content.length && content[content.length - 1] === '') content.pop();
      ops.push({ op: 'add', path: filePath, content: content.length ? content.join('\n') + '\n' : '' });
    } else if ((m = line.match(HDR_DELETE))) {
      ops.push({ op: 'delete', path: m[1] });
      i++;
    } else {
      return { error: `Unexpected line outside any file section: ${JSON.stringify(line.slice(0, 60))}` };
    }
  }

  if (ops.length === 0) return { error: 'Patch contains no operations.' };
  return { ops };
}

export interface ApplyOptions {
  cwd?: string;
  /** Optional workspace-fence check; return a non-null string to abort. */
  fenceCheck?: (abs: string) => string | null;
  /** Optional pre-write snapshot hook (for /rewind). */
  snapshot?: (abs: string) => void;
}

interface PlannedChange {
  op: 'update' | 'add' | 'delete';
  path: string;
  abs: string;
  oldContent?: string;
  newContent?: string;
}

/**
 * Validate every operation, then apply them all. Returns a human summary on
 * success or an `Error: …` string on the first validation failure (no writes).
 */
export function applyPatch(text: string, opts: ApplyOptions = {}): string {
  const cwd = opts.cwd || process.cwd();
  const parsed = parsePatch(text);
  if ('error' in parsed) return `Error: ${parsed.error}`;

  const plan: PlannedChange[] = [];

  // ── Validate everything first (no disk mutation) ──
  for (const op of parsed.ops) {
    const abs = path.resolve(cwd, op.path);
    if (opts.fenceCheck) { const f = opts.fenceCheck(abs); if (f) return f; }

    if (op.op === 'update') {
      if (!fs.existsSync(abs)) return `Error: Update target not found: ${op.path}`;
      let content: string;
      try { content = fs.readFileSync(abs, 'utf8'); } catch (e) { return `Error: cannot read ${op.path}: ${e}`; }
      const orig = content;
      for (const block of op.blocks) {
        if (block.search === block.replace) return `Error: a SEARCH/REPLACE block for ${op.path} is a no-op (identical).`;
        const n = countOccurrences(content, block.search);
        if (n === 0) return `Error: SEARCH block not found in ${op.path}: ${JSON.stringify(block.search.slice(0, 80))}`;
        if (n > 1) return `Error: SEARCH block is ambiguous in ${op.path} (appears ${n} times) — add more context to make it unique.`;
        content = content.replace(block.search, () => block.replace); // literal replacement
      }
      plan.push({ op: 'update', path: op.path, abs, oldContent: orig, newContent: content });
    } else if (op.op === 'add') {
      if (fs.existsSync(abs)) return `Error: Add target already exists: ${op.path} (use Update File to modify it)`;
      plan.push({ op: 'add', path: op.path, abs, newContent: op.content });
    } else {
      if (!fs.existsSync(abs)) return `Error: Delete target not found: ${op.path}`;
      plan.push({ op: 'delete', path: op.path, abs });
    }
  }

  // ── Apply (validation passed for all ops) ──
  const summary: string[] = [];
  for (const p of plan) {
    try {
      if (p.op === 'update') {
        opts.snapshot?.(p.abs);
        fs.writeFileSync(p.abs, p.newContent!, 'utf8');
        const d = unifiedDiff(p.oldContent!, p.newContent!, { context: 0 });
        summary.push(`~ ${p.path} (+${d.stat.added} -${d.stat.removed})`);
      } else if (p.op === 'add') {
        fs.mkdirSync(path.dirname(p.abs), { recursive: true });
        fs.writeFileSync(p.abs, p.newContent!, 'utf8');
        summary.push(`+ ${p.path} (new)`);
      } else {
        opts.snapshot?.(p.abs);
        fs.unlinkSync(p.abs);
        summary.push(`- ${p.path} (deleted)`);
      }
    } catch (e) {
      return `Error: patch validated but failed while writing ${p.path}: ${e}\nPartial summary:\n${summary.join('\n')}`;
    }
  }

  return `Applied patch — ${plan.length} file${plan.length !== 1 ? 's' : ''}:\n${summary.join('\n')}`;
}
