/**
 * Built-in tool registration — registers all default tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import type { ToolRegistry } from '../core/tool';
import { getLogger } from '../core/logger';
import { registerComputerTools } from './computer';
import { registerExtraTools } from './extra';
import { isPrivateIp, assertFetchAllowed, fenceRoot, fenceCheck } from './guards';

// Re-exported so existing importers/tests keep resolving these from builtin.
export { isPrivateIp, assertFetchAllowed, fenceRoot, fenceCheck };

const log = getLogger('builtin-tools');


/* ── Web search helpers ───────────────────────────────────────────────────
   Multi-engine fallback. DuckDuckGo's Instant Answer JSON API only returns
   "abstracts" and is blank for ~90% of real queries; HTML scraping is what
   actually works. In CN networks, DDG/Bing may be unreachable — Baidu/Sogou
   serve as fallbacks. Each parser is intentionally tolerant: HTML changes
   over time, so we extract loosely and let the engine list provide redundancy.
   ────────────────────────────────────────────────────────────────────────── */
interface SearchResult { title: string; url: string; snippet: string }

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const searchClient = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': SEARCH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  // Allow redirects (search engines use them)
  maxRedirects: 5,
  // Validate status (only 2xx is ok)
  validateStatus: (status) => status >= 200 && status < 300,
});

async function fetchHtml(url: string, timeoutMs = 15000, retries = 2): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await searchClient.get(url, {
        timeout: timeoutMs,
        // Skip SSRF check for known search engines
        transitional: { clarifyTimeoutError: true },
      });
      return res.data;
    } catch (e: any) {
      lastError = e;
      // Don't retry on 4xx (client errors like 403/404)
      if (e.response && e.response.status >= 400 && e.response.status < 500) {
        throw new Error(`HTTP ${e.response.status}: ${e.response.statusText || 'Blocked'}`);
      }
      // Wait before retry (exponential backoff)
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error('fetch failed');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function unwrapDdgRedirect(href: string): string {
  // DuckDuckGo HTML wraps results in /l/?uddg=<encoded-url>
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

function unwrapBaiduRedirect(href: string): string {
  // Baidu uses opaque /link?url=... redirects; we can't resolve without another request.
  // Return as-is; consumer can still click through.
  return href;
}

async function searchDuckDuckGo(query: string, max: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < max) {
    results.push({ url: unwrapDdgRedirect(m[1]), title: stripTags(m[2]), snippet: stripTags(m[3]) });
  }
  return results;
}

async function searchBing(query: string, max: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-cn`);
  const results: SearchResult[] = [];
  const liRe = /<li class="b_algo"[\s\S]*?<\/li>/gi;
  const items = html.match(liRe) || [];
  for (const item of items) {
    if (results.length >= max) break;
    const a = item.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const snipMatch =
      item.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      item.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ url: a[1], title: stripTags(a[2]), snippet: snipMatch ? stripTags(snipMatch[1]) : '' });
  }
  return results;
}

async function searchBaidu(query: string, max: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  // Baidu nests divs aggressively; anchor on <h3> ... <a href>...</a> and look
  // for the nearest abstract block following.
  const re = /<h3[^>]*>[\s\S]{0,500}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < max) {
    const url = unwrapBaiduRedirect(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    const after = html.slice(re.lastIndex, re.lastIndex + 4000);
    const snipMatch =
      after.match(/<span class="content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
      after.match(/<div class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      after.match(/<span[^>]*content[^"]*"[^>]*>([\s\S]{20,400}?)<\/span>/i) ||
      after.match(/<p[^>]*>([\s\S]{20,400}?)<\/p>/i);
    results.push({ url, title, snippet: snipMatch ? stripTags(snipMatch[1]) : '' });
  }
  return results;
}

async function searchSogou(query: string, max: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  const divRe = /<div[^>]+class="vrwrap"[\s\S]*?(?=<div[^>]+class="vrwrap"|$)/gi;
  const items = html.match(divRe) || [];
  for (const item of items) {
    if (results.length >= max) break;
    const a = item.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = a[1];
    if (url.startsWith('/link?')) url = 'https://www.sogou.com' + url;
    const snipMatch =
      item.match(/<div[^>]+class="(?:str_info|fz-mid|space-txt)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      item.match(/<p[^>]*>([\s\S]{20,400}?)<\/p>/i);
    results.push({ url, title: stripTags(a[2]), snippet: snipMatch ? stripTags(snipMatch[1]) : '' });
  }
  return results;
}

async function runSearchEngine(engine: string, query: string, max: number): Promise<SearchResult[]> {
  let results: SearchResult[];
  switch (engine) {
    case 'duckduckgo': case 'ddg': results = await searchDuckDuckGo(query, max); break;
    case 'bing': results = await searchBing(query, max); break;
    case 'baidu': results = await searchBaidu(query, max); break;
    case 'sogou': results = await searchSogou(query, max); break;
    default: throw new Error(`unknown search engine: ${engine}`);
  }
  // Drop placeholder/JS-anchor entries from inline answer cards.
  return results.filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

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
    description: 'Edit a file by replacing old_text with new_text. Use this for targeted edits.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the file to edit', required: true },
      { name: 'old_text', type: 'string', description: 'Text to search for and replace', required: true },
      { name: 'new_text', type: 'string', description: 'Text to replace with', required: true },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      try {
        let content = fs.readFileSync(filePath, 'utf-8');
        const oldText = params.old_text as string;
        const newText = params.new_text as string;
        if (!content.includes(oldText)) {
          return `Error: old_text not found in file. Searched for: ${oldText.slice(0, 50)}...`;
        }
        content = content.replace(oldText, newText);
        fs.writeFileSync(filePath, content, 'utf-8');
        return `Successfully edited ${filePath}`;
      } catch (e) {
        return `Error editing file: ${e}`;
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
    description: 'Execute a shell command and return its output.',
    parameters: [
      { name: 'command', type: 'string', description: 'Command to execute', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout in milliseconds (default: 30000)', required: false },
    ],
    handler: async (params) => {
      const cmd = params.command as string;
      const timeout = (params.timeout as number) || 30000;
      try {
        const { runInSandbox, formatSandboxResult } = require('../core/sandbox');
        const result = runInSandbox(cmd, { timeoutMs: timeout });
        return formatSandboxResult(result);
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
    dangerous: true,
  });

  // ── HTTP Tools ──

  registry.register({
    name: 'http_get',
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
    description: 'Search the web for information. Returns search results with titles, URLs and snippets.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'engine', type: 'string', description: 'Optional engine: duckduckgo|bing|baidu|sogou. Default: auto (tries each until one returns results)', required: false },
      { name: 'max_results', type: 'number', description: 'Max results to return (default 8, capped at 20)', required: false },
    ],
    handler: async (params) => {
      const query = String(params.query || '').trim();
      if (!query) return 'Error: query is required';
      const max = Math.max(1, Math.min(20, Math.floor(Number(params.max_results) || 8)));
      const explicit = String(params.engine || '').trim().toLowerCase();
      const envEngine = String(process.env.SKYLOOM_SEARCH_ENGINE || '').trim().toLowerCase();
      const order = explicit
        ? [explicit]
        : envEngine
        ? [envEngine, 'duckduckgo', 'bing', 'baidu', 'sogou']
        : ['duckduckgo', 'bing', 'baidu', 'sogou'];
      const seen = new Set<string>();
      const tried: string[] = [];
      for (const eng of order) {
        if (seen.has(eng)) continue;
        seen.add(eng);
        tried.push(eng);
        try {
          const results = await runSearchEngine(eng, query, max);
          if (results && results.length > 0) {
            const head = `Search results (${eng}, ${results.length}):`;
            const body = results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
              .join('\n');
            return `${head}\n${body}`;
          }
        } catch (e: any) {
          log.warn('web_search_engine_failed', { engine: eng, error: String(e?.message || e) });
        }
      }
      return `No search results found (tried: ${tried.join(', ')}). Set SKYLOOM_SEARCH_ENGINE to pin an engine, or try a different query.`;
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
