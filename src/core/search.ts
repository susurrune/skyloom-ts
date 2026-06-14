/**
 * Code search — a dependency-light, cross-platform engine for "find where X is
 * used and read it in context". Backs the code_search tool and is the fallback
 * for grep when ripgrep/grep aren't installed (common on Windows), so search
 * never silently returns nothing just because a binary is missing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

export interface SearchOptions {
  pattern: string;
  /** Root directory to search (default: cwd). */
  root?: string;
  /** Glob to restrict files (e.g. "**\/*.ts"). Default: all files. */
  glob?: string;
  /** Case-insensitive match (default false). */
  ignoreCase?: boolean;
  /** Treat pattern as a regular expression (default true). */
  regex?: boolean;
  /** Lines of context around each match (default 0). */
  context?: number;
  /** Cap on total matches returned (default 200). */
  maxResults?: number;
  /** Skip files larger than this many bytes (default 2 MiB). */
  maxFileBytes?: number;
}

export interface SearchMatch {
  file: string;     // relative to root
  line: number;     // 1-based
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  filesScanned: number;
  truncated: boolean;
  error?: string;
}

/** Directories never worth searching — vendored, generated, or VCS internals. */
const DEFAULT_IGNORES = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/coverage/**', '**/.next/**', '**/out/**', '**/.cache/**',
  '**/vendor/**', '**/.venv/**', '**/__pycache__/**',
];

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // NUL byte ⇒ binary
  return false;
}

/** Pure-JS recursive code search. No external process required. */
export function searchCode(opts: SearchOptions): SearchResult {
  const root = path.resolve(opts.root || process.cwd());
  const maxResults = opts.maxResults ?? 200;
  const maxFileBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const context = Math.max(0, opts.context ?? 0);

  let matcher: (line: string) => boolean;
  if (opts.regex === false) {
    const needle = opts.ignoreCase ? opts.pattern.toLowerCase() : opts.pattern;
    matcher = (line) => (opts.ignoreCase ? line.toLowerCase() : line).includes(needle);
  } else {
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, opts.ignoreCase ? 'i' : '');
    } catch (e) {
      return { matches: [], filesScanned: 0, truncated: false, error: `invalid regex: ${e}` };
    }
    matcher = (line) => re.test(line);
  }

  let files: string[];
  try {
    files = globSync(opts.glob || '**/*', {
      cwd: root, nodir: true, dot: false, ignore: DEFAULT_IGNORES,
    });
  } catch (e) {
    return { matches: [], filesScanned: 0, truncated: false, error: `glob failed: ${e}` };
  }

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  for (const rel of files) {
    if (matches.length >= maxResults) { truncated = true; break; }
    const abs = path.join(root, rel);
    let buf: Buffer;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > maxFileBytes) continue;
      buf = fs.readFileSync(abs);
    } catch { continue; }
    if (looksBinary(buf)) continue;

    filesScanned++;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!matcher(lines[i])) continue;
      const m: SearchMatch = { file: rel.split(path.sep).join('/'), line: i + 1, text: lines[i] };
      if (context > 0) {
        m.before = lines.slice(Math.max(0, i - context), i);
        m.after = lines.slice(i + 1, i + 1 + context);
      }
      matches.push(m);
      if (matches.length >= maxResults) { truncated = true; break; }
    }
  }

  return { matches, filesScanned, truncated };
}

/** Render a SearchResult as ripgrep-style `file:line:text` (with context). */
export function formatSearchResult(res: SearchResult): string {
  if (res.error) return `Search error: ${res.error}`;
  if (res.matches.length === 0) return 'No matches found.';
  const out: string[] = [];
  let lastFile = '';
  for (const m of res.matches) {
    if (m.file !== lastFile) { if (out.length) out.push(''); lastFile = m.file; }
    for (let k = 0; k < (m.before?.length || 0); k++) {
      out.push(`${m.file}:${m.line - (m.before!.length - k)}- ${m.before![k]}`);
    }
    out.push(`${m.file}:${m.line}: ${m.text}`);
    for (let k = 0; k < (m.after?.length || 0); k++) {
      out.push(`${m.file}:${m.line + k + 1}- ${m.after![k]}`);
    }
  }
  if (res.truncated) out.push(`\n…[results truncated at ${res.matches.length} matches — narrow the pattern or glob]`);
  return out.join('\n');
}
