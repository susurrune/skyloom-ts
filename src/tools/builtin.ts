/**
 * Built-in tool registration — registers all default tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolRegistry } from '../core/tool';
import { getLogger } from '../core/logger';
import { registerComputerTools } from './computer';
import { registerExtraTools } from './extra';
import { isPrivateIp, assertFetchAllowed, fenceRoot, fenceCheck } from './guards';
import { webSearch, formatSearchResults, readPage } from './websearch';
import { countOccurrences, unifiedDiff } from '../core/diff';
import { getDiagnostics, formatDiagnostics } from '../core/diagnostics';

// Re-exported so existing importers/tests keep resolving these from builtin.
export { isPrivateIp, assertFetchAllowed, fenceRoot, fenceCheck };

const log = getLogger('builtin-tools');

/**
 * Register all built-in tools into the given registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  // Register computer-operation + extended-capability tools
  registerComputerTools(registry);
  registerExtraTools(registry);
  // ── File Tools ──

  registry.register({
    name: 'read_file',
    idempotent: true,
    description: 'Read the contents of a file. Large files are paged: pass offset (1-based start line) and limit (line count) to read further sections; use grep to locate the right offset first.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute or relative path to the file', required: true },
      { name: 'offset', type: 'number', description: '1-based line number to start from (default 1)', required: false },
      { name: 'limit', type: 'number', description: 'Max lines to return (default 800)', required: false },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const offset = Math.max(1, Number(params.offset) || 1);
        const limit = Math.max(1, Math.min(Number(params.limit) || 800, 4000));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const remaining = lines.length - (offset - 1 + slice.length);
        const tail = remaining > 0
          ? `\n…[还有 ${remaining} 行 — read_file(path, offset=${offset + slice.length}) 继续]`
          : '';
        const range = offset > 1 || remaining > 0 ? ` lines ${offset}-${offset + slice.length - 1}/${lines.length}` : '';
        return `Successfully read ${filePath}${range}:\n${slice.join('\n')}${tail}`;
      } catch (e) {
        return `Error reading file: ${e}`;
      }
    },
  });

  registry.register({
    name: 'write_file',
    description: 'Write content to a file at the given path. Creates directories if needed.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute or relative path to write to', required: true },
      { name: 'content', type: 'string', description: 'Content to write to the file', required: true },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, params.content as string, 'utf-8');
        return `Successfully wrote ${Buffer.byteLength(params.content as string, 'utf-8')} bytes to ${filePath}`;
      } catch (e) {
        return `Error writing file: ${e}`;
      }
    },
  });

  registry.register({
    name: 'edit_file',
    description: 'Edit a file by replacing an exact occurrence of old_text with new_text. old_text must match the file exactly (including whitespace and indentation) and must be UNIQUE — include enough surrounding context to disambiguate, or set replace_all to change every occurrence. Returns a unified diff of the change.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the file to edit', required: true },
      { name: 'old_text', type: 'string', description: 'Exact text to replace (must match the file verbatim, and be unique unless replace_all is set)', required: true },
      { name: 'new_text', type: 'string', description: 'Replacement text (must differ from old_text)', required: true },
      { name: 'replace_all', type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match (default false)', required: false },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      const oldText = params.old_text as string;
      const newText = params.new_text as string;
      const replaceAll = params.replace_all === true || params.replace_all === 'true';
      if (oldText === newText) return 'Error: old_text and new_text are identical — nothing to change.';
      try {
        const orig = fs.readFileSync(filePath, 'utf-8');
        const n = countOccurrences(orig, oldText);
        if (n === 0) {
          return `Error: old_text not found in ${filePath}. It must match exactly (including whitespace). Searched for: ${JSON.stringify(oldText.slice(0, 80))}`;
        }
        if (n > 1 && !replaceAll) {
          return `Error: old_text appears ${n} times in ${filePath} — the edit is ambiguous. Add more surrounding context to make it unique, or set replace_all=true to change all ${n} occurrences.`;
        }
        // Literal replacement: split/join (replace_all) and a function replacer
        // (single) both avoid String.replace interpreting `$&`/`$1` in new_text.
        const updated = replaceAll
          ? orig.split(oldText).join(newText)
          : orig.replace(oldText, () => newText);
        fs.writeFileSync(filePath, updated, 'utf-8');
        const rel = path.relative(process.cwd(), filePath) || filePath;
        const diff = unifiedDiff(orig, updated, { path: rel, context: 3 });
        const occ = replaceAll ? ` (${n} occurrence${n > 1 ? 's' : ''})` : '';
        const body = diff.text ? `\n${diff.text}` : '';
        return `Successfully edited ${filePath}${occ} · +${diff.stat.added} -${diff.stat.removed}${body}`;
      } catch (e) {
        return `Error editing file: ${e}`;
      }
    },
  });

  registry.register({
    name: 'get_diagnostics',
    idempotent: true,
    description: 'Get LSP-style diagnostics (type errors, lint issues with line:col) for a source file. TS/JS work out of the box via the workspace TypeScript; other languages use a configured checker (config.yaml diagnostics map). Call this after editing code to confirm it is error-free, or to locate the root cause of a type error.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the source file to check', required: true },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      let config: any = {};
      try { const { loadConfig } = require('../core/config'); config = loadConfig(); } catch { /* defaults */ }
      try {
        const result = getDiagnostics(filePath, config);
        if (!Array.isArray(result)) return `[diagnostics unavailable] ${result.unavailable}`;
        return formatDiagnostics(path.relative(process.cwd(), filePath) || filePath, result);
      } catch (e) {
        return `Error getting diagnostics: ${e}`;
      }
    },
  });

  registry.register({
    name: 'delete_file',
    description: 'Delete a file at the given path.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the file to delete', required: true },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      try {
        fs.unlinkSync(filePath);
        return `Successfully deleted ${filePath}`;
      } catch (e) {
        return `Error deleting file: ${e}`;
      }
    },
  });

  registry.register({
    name: 'list_directory',
    idempotent: true,
    description: 'List files and directories at the given path.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to list', required: true },
    ],
    handler: async (params) => {
      const dirPath = path.resolve(params.path as string);
      const fenced = fenceCheck(dirPath); if (fenced) return fenced;
      if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;
      try {
        const entries = fs.readdirSync(dirPath);
        return entries.map(e => {
          const stat = fs.statSync(path.join(dirPath, e));
          return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${e}`;
        }).join('\n');
      } catch (e) {
        return `Error listing directory: ${e}`;
      }
    },
  });

  registry.register({
    name: 'file_search',
    idempotent: true,
    description: 'Search for files matching a glob pattern.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts")', required: true },
      { name: 'directory', type: 'string', description: 'Directory to search in (default: cwd)', required: false },
    ],
    handler: async (params) => {
      const dir = params.directory ? path.resolve(params.directory as string) : process.cwd();
      const fenced = fenceCheck(dir); if (fenced) return fenced;
      const pattern = params.pattern as string;
      try {
        const { globSync } = require('glob');
        const results = globSync(pattern, { cwd: dir, nodir: true });
        if (results.length === 0) return 'No files found matching the pattern.';
        return results.slice(0, 200).join('\n') + (results.length > 200 ? `\n... and ${results.length - 200} more` : '');
      } catch (e) {
        return `Error searching files: ${e}`;
      }
    },
  });

  // ── Shell Tool ──

  registry.register({
    name: 'run_bash',
    description: 'Execute a shell command and return its output. Set background=true for long-running processes (dev servers, watchers, builds): it returns a job id immediately — read its output later with bash_output, stop it with kill_bash.',
    parameters: [
      { name: 'command', type: 'string', description: 'Command to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in milliseconds (default: 30000). Ignored when background=true.', required: false },
      { name: 'background', type: 'boolean', description: 'Run detached in the background and return a job id instead of blocking (default false)', required: false },
    ],
    handler: async (params) => {
      const cmd = params.command as string;
      const background = params.background === true || params.background === 'true';
      if (background) {
        try {
          const { getBackgroundManager } = require('../core/bgproc');
          const { id, error } = getBackgroundManager().start(cmd);
          if (error) return error;
          return `[background job ${id} started] pid running. Use bash_output("${id}") to read output, kill_bash("${id}") to stop, list_bash to see all jobs.`;
        } catch (e: any) { return `Error: ${e.message || e}`; }
      }
      const timeout = (params.timeout as number) || 30000;
      try {
        const { runInSandbox, formatSandboxResult } = require('../core/sandbox');
        const result = runInSandbox(cmd, { timeoutMs: timeout });
        return formatSandboxResult(result);
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
    dangerous: true,
  });

  registry.register({
    name: 'bash_output',
    description: 'Read new output from a background shell job (started by run_bash with background=true) since the last read, plus its current status.',
    parameters: [
      { name: 'id', type: 'string', description: 'The background job id', required: true },
    ],
    handler: async (params) => {
      const { getBackgroundManager } = require('../core/bgproc');
      const r = getBackgroundManager().read(String(params.id || ''));
      if (!r.ok) return r.error || 'Error reading background job.';
      const statusLine = `[job ${params.id} · ${r.status}${r.exitCode != null ? ` · exit ${r.exitCode}` : ''}]`;
      const out = r.text && r.text.length ? r.text : '(no new output)';
      return `${statusLine}\n${out}`;
    },
  });

  registry.register({
    name: 'list_bash',
    description: 'List background shell jobs with their status, pid, and runtime.',
    parameters: [],
    handler: async () => {
      const { getBackgroundManager } = require('../core/bgproc');
      const jobs = getBackgroundManager().list();
      if (!jobs.length) return 'No background jobs.';
      return jobs.map((j: any) => {
        const dur = ((j.endedAt || Date.now()) - j.startedAt) / 1000;
        const ex = j.exitCode != null ? ` exit ${j.exitCode}` : '';
        return `${j.id} · ${j.status}${ex} · pid ${j.pid ?? '?'} · ${dur.toFixed(1)}s · ${j.command.slice(0, 60)}`;
      }).join('\n');
    },
  });

  registry.register({
    name: 'kill_bash',
    description: 'Terminate a running background shell job.',
    parameters: [
      { name: 'id', type: 'string', description: 'The background job id to kill', required: true },
    ],
    handler: async (params) => {
      const { getBackgroundManager } = require('../core/bgproc');
      const r = getBackgroundManager().kill(String(params.id || ''));
      return r.ok ? `[job ${params.id} killed]` : (r.error || 'Error killing background job.');
    },
  });

  // ── HTTP Tools ──

  registry.register({
    name: 'http_get',
    idempotent: true,
    description: 'Make an HTTP GET request to a URL.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to fetch', required: true },
    ],
    handler: async (params) => {
      try {
        await assertFetchAllowed(params.url as string);
        const response = await fetch(params.url as string);
        const text = await response.text();
        return `Status: ${response.status}\n\n${text.slice(0, 10000)}${text.length > 10000 ? '\n...[truncated]' : ''}`;
      } catch (e) {
        return `Error fetching URL: ${e instanceof Error ? e.message : e}`;
      }
    },
  });

  // ── Task Management ──

  registry.register({
    name: 'task_done',
    description: 'Signal that the current task is complete and provide a summary. Call this when you have finished the work.',
    parameters: [
      { name: 'summary', type: 'string', description: 'Summary of what was accomplished', required: false },
    ],
    handler: async (_params) => {
      return '__TASK_DONE__';
    },
    cacheable: false,
  });

  // ── Search Tool ──

  registry.register({
    name: 'web_search',
    idempotent: true,
    description:
      'Search the live web and return titles, URLs, and snippets (plus a direct answer when available). ' +
      'USE THIS whenever the answer depends on current or real-time information — today\'s news and hot topics, ' +
      'recent events, latest releases/versions, prices, weather, scores, or anything that may have changed since your ' +
      'training cutoff. Do NOT answer such questions from memory and do NOT claim you cannot access the internet — ' +
      'search first, then answer with the findings and cite the source URLs. Follow up with read_url to read a result in full.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query. Be specific; include the year/date for time-sensitive queries.', required: true },
      { name: 'engine', type: 'string', description: 'Optional provider: tavily|brave|serper|searxng|jina|duckduckgo|bing|baidu|sogou. Default: auto (uses a configured API key if present, else the keyless Jina endpoint, else scraping).', required: false },
      { name: 'max_results', type: 'number', description: 'Max results to return (default 8, capped at 20)', required: false },
    ],
    handler: async (params) => {
      const query = String(params.query || '').trim();
      if (!query) return 'Error: query is required';
      try {
        const res = await webSearch(query, {
          max: Number(params.max_results) || 8,
          engine: String(params.engine || '').trim().toLowerCase() || undefined,
          onProviderError: (provider, error) => log.warn('web_search_provider_failed', { provider, error }),
        });
        return formatSearchResults(res);
      } catch (e: any) {
        return `Error: ${String(e?.message || e)}`;
      }
    },
  });

  registry.register({
    name: 'read_url',
    idempotent: true,
    description:
      'Fetch a web page as clean, readable text (markdown), with boilerplate (nav/ads) stripped. ' +
      'Use after web_search to read a result in full, or to read any known URL. Prefer this over http_get for articles/pages.',
    parameters: [
      { name: 'url', type: 'string', description: 'The http(s) URL to read', required: true },
      { name: 'max_chars', type: 'number', description: 'Max characters to return (default 12000)', required: false },
    ],
    handler: async (params) => {
      const url = String(params.url || '').trim();
      if (!url) return 'Error: url is required';
      try {
        return await readPage(url, { maxChars: Number(params.max_chars) || 12000 });
      } catch (e: any) {
        return `Error reading page: ${String(e?.message || e)}`;
      }
    },
  });

  // ── Memory Tools ──

  registry.register({
    name: 'remember_fact',
    description: 'Store a fact about the user or project in long-term memory.',
    parameters: [
      { name: 'key', type: 'string', description: 'Fact key (snake_case)', required: true },
      { name: 'value', type: 'string', description: 'Fact value', required: true },
      { name: 'category', type: 'string', description: 'Category (e.g. user_pref, project_info)', required: false },
    ],
    handler: async (_params) => {
      return 'Fact stored. (Memory integration at agent level.)';
    },
  });

  registry.register({
    name: 'recall_facts',
    description: 'Recall stored facts from long-term memory.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query to match against stored facts', required: true },
    ],
    handler: async (_params) => {
      return 'Recall handled at agent level.';
    },
  });

  // ── Git Tools ──

  registry.register({
    name: 'git_status',
    description: 'Show the working tree status.',
    parameters: [],
    handler: async () => {
      const { execSync } = require('child_process');
      try {
        return execSync('git status', { encoding: 'utf-8' });
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
    },
  });

  registry.register({
    name: 'git_diff',
    description: 'Show changes between commits, commit and working tree, etc.',
    parameters: [
      { name: 'staged', type: 'boolean', description: 'Show staged changes only', required: false },
    ],
    handler: async (params) => {
      const { execSync } = require('child_process');
      try {
        const args = params.staged ? '--staged' : '';
        return execSync(`git diff ${args}`, { encoding: 'utf-8' });
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
    },
  });

  registry.register({
    name: 'git_log',
    description: 'Show commit logs.',
    parameters: [
      { name: 'max_count', type: 'number', description: 'Number of commits to show (default: 10)', required: false },
    ],
    handler: async (params) => {
      const { execFileSync } = require('child_process');
      try {
        const n = Math.max(1, Math.min(1000, Math.floor(Number(params.max_count) || 10)));
        return execFileSync('git', ['log', '--oneline', `-${n}`], { encoding: 'utf-8' });
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
    },
  });

  registry.register({
    name: 'git_commit',
    description: 'Create a new commit with the given message.',
    parameters: [
      { name: 'message', type: 'string', description: 'Commit message', required: true },
    ],
    handler: async (params) => {
      const { execFileSync } = require('child_process');
      try {
        const msg = String(params.message ?? '');
        // execFileSync passes the message as a single argv entry — no shell, so
        // backticks / $() / ; in the message cannot be interpreted.
        execFileSync('git', ['commit', '-m', msg], { encoding: 'utf-8' });
        return 'Commit created successfully.';
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
    },
    dangerous: true,
  });

  // ── Utility Tools ──

  registry.register({
    name: 'grep',
    idempotent: true,
    description: 'Search for a pattern in files using ripgrep or grep.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Regex pattern to search for', required: true },
      { name: 'path', type: 'string', description: 'Directory to search in', required: false },
    ],
    handler: async (params) => {
      const { execFileSync } = require('child_process');
      const searchDir = params.path ? path.resolve(params.path as string) : process.cwd();
      const fenced = fenceCheck(searchDir); if (fenced) return fenced;
      const pat = String(params.pattern || '');
      // No shell: pattern and directory are passed as argv entries, and `--`
      // stops a leading `-` in the pattern from being read as a flag. This is a
      // non-dangerous (auto-approved) tool, so shell injection here would have
      // bypassed the tool-approval gate entirely.
      const variants: [string, string[]][] = [
        ['rg', ['-n', '--', pat, searchDir]],
        ['grep', ['-rn', '--', pat, searchDir]],
      ];
      for (const [bin, args] of variants) {
        try {
          const out = execFileSync(bin, args, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
          return out || 'No matches found.';
        } catch (e: any) {
          // exit status 1 = ran successfully, zero matches; anything else
          // (e.g. binary not installed) falls through to the next variant.
          if (e?.status === 1) return 'No matches found.';
        }
      }
      return 'No matches found.';
    },
  });

  registry.register({
    name: 'tree',
    idempotent: true,
    description: 'Display directory tree structure.',
    parameters: [
      { name: 'directory', type: 'string', description: 'Directory to show tree for', required: false },
      { name: 'depth', type: 'number', description: 'Maximum depth (default: 3)', required: false },
    ],
    handler: async (params) => {
      const { execFileSync } = require('child_process');
      const treeDir = params.directory ? path.resolve(params.directory as string) : process.cwd();
      const fenced = fenceCheck(treeDir); if (fenced) return fenced;
      const depth = Math.max(1, Math.min(20, Math.floor(Number(params.depth) || 3)));
      try {
        // No shell: directory passed as an argv entry, depth clamped to an int.
        const out = execFileSync('tree', [treeDir, '-L', String(depth), '--charset=utf-8'], { encoding: 'utf-8' });
        return out;
      } catch {
        return 'Directory tree unavailable.';
      }
    },
  });

  log.info('builtin_tools_registered', { count: registry.listNames().length });
}

let _httpClient: any = null;

export async function closeHttpClient(): Promise<void> {
  if (_httpClient) {
    try { await _httpClient.close?.(); } catch { /* ignore */ }
    _httpClient = null;
  }
}
