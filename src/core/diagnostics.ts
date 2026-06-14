/**
 * Code diagnostics — the LSP capability that matters most to an agent: surface
 * real type/lint errors (with line:col) so the model fixes root causes instead
 * of guessing.
 *
 * Strategy, in order:
 *   1. TS/JS  → the TypeScript compiler API, resolved from the user's workspace
 *               node_modules (then sky's own). Real semantic diagnostics, no
 *               language server to install.
 *   2. other  → a configured external checker command (config.diagnostics map
 *               of `ext -> "cmd {file}"`), output parsed for `file:line:col msg`.
 *
 * This is intentionally not a full LSP client (hover/goto/rename); it delivers
 * the diagnostics that close the agent's edit→verify loop on a per-file basis.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getLogger } from './logger';

const log = getLogger('diagnostics');

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  line: number;      // 1-based
  column: number;    // 1-based
  severity: Severity;
  message: string;
  code?: string;
  source?: string;   // 'ts' | external command name
}

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Resolve the TypeScript module the way an LSP would: workspace first. */
function loadTypescript(cwd: string): any | null {
  const bases = [cwd, process.cwd(), __dirname];
  for (const base of bases) {
    try {
      const p = require.resolve('typescript', { paths: [base] });
      return require(p);
    } catch { /* try next */ }
  }
  try { return require('typescript'); } catch { return null; }
}

function findNearest(file: string, name: string): string | null {
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Semantic + syntactic diagnostics for one TS/JS file via the compiler API. */
export function getTypeScriptDiagnostics(file: string, cwd: string = process.cwd()): Diagnostic[] | { unavailable: string } {
  const ts = loadTypescript(cwd);
  if (!ts) return { unavailable: 'typescript not installed in workspace or sky — cannot type-check.' };

  const abs = path.resolve(file);
  let options: any = { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
  let fileNames: string[] = [abs];

  const tsconfig = findNearest(abs, 'tsconfig.json');
  if (tsconfig) {
    try {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(read.config || {}, ts.sys, path.dirname(tsconfig));
      options = { ...parsed.options, noEmit: true };
      // Keep the project's file set so cross-file types resolve, but ensure our
      // target is included.
      fileNames = parsed.fileNames.includes(abs) ? parsed.fileNames : [...parsed.fileNames, abs];
    } catch (e) {
      log.warn('tsconfig_parse_failed', { tsconfig, error: String(e) });
    }
  }

  let program: any;
  try {
    program = ts.createProgram(fileNames, options);
  } catch (e) {
    return { unavailable: `failed to build TypeScript program: ${e}` };
  }
  const source = program.getSourceFile(abs);
  if (!source) return { unavailable: `file not part of the TypeScript program: ${abs}` };

  const raw = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ];

  const out: Diagnostic[] = [];
  for (const d of raw) {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    let line = 1, column = 1;
    if (d.file && typeof d.start === 'number') {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      line = pos.line + 1;
      column = pos.character + 1;
    }
    const severity: Severity = d.category === 1 ? 'error' : d.category === 0 ? 'warning' : 'info';
    out.push({ line, column, severity, message, code: d.code ? `TS${d.code}` : undefined, source: 'ts' });
  }
  out.sort((a, b) => a.line - b.line || a.column - b.column);
  return out;
}

/** Parse generic `path:line:col: message` style compiler/linter output. */
export function parseDiagnosticOutput(output: string, source: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.*?):(\d+):(\d+):?\s*(error|warning|info)?:?\s*(.*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const sev = (m[4] || 'error').toLowerCase() as Severity;
    out.push({
      line: parseInt(m[2], 10) || 1,
      column: parseInt(m[3], 10) || 1,
      severity: sev === 'warning' || sev === 'info' ? sev : 'error',
      message: (m[5] || '').trim(),
      source,
    });
  }
  return out;
}

/** Run a configured external checker for a non-TS file. */
function getExternalDiagnostics(file: string, command: string): Diagnostic[] | { unavailable: string } {
  const cmd = command.includes('{file}')
    ? command.replace(/\{file\}/g, JSON.stringify(file))
    : `${command} ${JSON.stringify(file)}`;
  let output = '';
  try {
    output = execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    // Linters exit non-zero when they find problems — that's the normal path.
    output = `${e.stdout || ''}\n${e.stderr || ''}`;
  }
  return parseDiagnosticOutput(output, command.split(/\s+/)[0]);
}

/**
 * Get diagnostics for a file. `config.diagnostics` is an optional map of
 * `ext -> command` for non-TS languages (e.g. { py: "ruff check {file}" }).
 */
export function getDiagnostics(file: string, config?: any, cwd: string = process.cwd()): Diagnostic[] | { unavailable: string } {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { unavailable: `file not found: ${abs}` };

  const ext = path.extname(abs).toLowerCase();
  const map = (config?.diagnostics || {}) as Record<string, string>;
  const extKey = ext.replace(/^\./, '');

  // Explicit user config wins.
  if (map[extKey]) return getExternalDiagnostics(abs, map[extKey]);
  if (TS_EXTS.has(ext)) return getTypeScriptDiagnostics(abs, cwd);

  return { unavailable: `no diagnostics provider for '${ext}'. Configure one in config.yaml diagnostics: { ${extKey || 'ext'}: "<checker> {file}" }` };
}

export function formatDiagnostics(file: string, diags: Diagnostic[]): string {
  if (diags.length === 0) return `✓ ${file} — no diagnostics (clean).`;
  const errs = diags.filter(d => d.severity === 'error').length;
  const warns = diags.filter(d => d.severity === 'warning').length;
  const head = `${file} — ${errs} error${errs !== 1 ? 's' : ''}, ${warns} warning${warns !== 1 ? 's' : ''}:`;
  const lines = diags.slice(0, 100).map(d => {
    const mark = d.severity === 'error' ? '✗' : d.severity === 'warning' ? '⚠' : 'ℹ';
    const code = d.code ? ` ${d.code}` : '';
    return `  ${mark} ${d.line}:${d.column}${code} — ${d.message.replace(/\n/g, ' ')}`;
  });
  const more = diags.length > 100 ? `\n  …and ${diags.length - 100} more` : '';
  return `${head}\n${lines.join('\n')}${more}`;
}
