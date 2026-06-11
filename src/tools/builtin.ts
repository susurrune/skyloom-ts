/**
 * Built-in tool registration — registers all default tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import { lookup } from 'dns/promises';
import type { ToolRegistry } from '../core/tool';
import { getLogger } from '../core/logger';
import { registerComputerTools } from './computer';

const log = getLogger('builtin-tools');

/* ── SSRF guard for outbound fetches ──────────────────────────────────────
   http_get is auto-approved (DangerLevel.LOW), so without this an agent or
   prompt-injected content could pivot to internal services / cloud metadata
   (169.254.169.254). We block private, loopback and link-local targets — both
   when the URL is an IP literal and after DNS resolution. Operators who need to
   reach internal hosts set SKYLOOM_ALLOW_PRIVATE_FETCH=1.
   ────────────────────────────────────────────────────────────────────────── */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 127) return true;                 // this-host / loopback
  if (a === 10) return true;                             // private
  if (a === 172 && b >= 16 && b <= 31) return true;      // private
  if (a === 192 && b === 168) return true;               // private
  if (a === 169 && b === 254) return true;               // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) {                         // IPv4-mapped IPv6
    const mapped = v.slice(7);
    if (mapped.includes('.')) return isPrivateIPv4(mapped);
  }
  if (/^f[cd]/.test(v)) return true;                     // fc00::/7 unique-local
  if (/^fe[89ab]/.test(v)) return true;                  // fe80::/10 link-local
  if (v.includes('.') && !v.includes(':')) return isPrivateIPv4(v);
  return false;
}

export { isPrivateIp, assertFetchAllowed }; // exported for tests

async function assertFetchAllowed(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error(`invalid URL: ${rawUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`blocked URL scheme '${u.protocol}' — only http/https are allowed`);
  }
  if (process.env.SKYLOOM_ALLOW_PRIVATE_FETCH === '1') return;
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (isPrivateIp(host)) {
    throw new Error(`blocked request to private/loopback address ${host} (set SKYLOOM_ALLOW_PRIVATE_FETCH=1 to allow)`);
  }
  let addrs: Array<{ address: string }> = [];
  try { addrs = await lookup(host, { all: true }); } catch { return; /* let fetch surface DNS errors */ }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(`blocked request: ${host} resolves to private address ${a.address} (set SKYLOOM_ALLOW_PRIVATE_FETCH=1 to allow)`);
    }
  }
}

/**
 * Register all built-in tools into the given registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  // Register computer tools
  registerComputerTools(registry);
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
    description: 'Search the web for information. Returns search results with titles and snippets.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
    ],
    handler: async (params) => {
      // Simplified web search using a basic approach
      try {
        const query = encodeURIComponent(params.query as string);
        const url = `https://api.duckduckgo.com/?q=${query}&format=json`;
        const response = await fetch(url);
        const data = await response.json() as Record<string, any>;
        const results: string[] = [];
        if (data.AbstractText) results.push(`Abstract: ${data.AbstractText}`);
        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics.slice(0, 10)) {
            if (topic.Text) results.push(`- ${topic.Text}`);
            else if (topic.Topics) {
              for (const sub of topic.Topics.slice(0, 5)) {
                if (sub.Text) results.push(`- ${sub.Text}`);
              }
            }
          }
        }
        return results.length > 0 ? results.join('\n') : 'No search results found.';
      } catch (e) {
        return `Search error: ${e}`;
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
    description: 'Search for a pattern in files using ripgrep or grep.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Regex pattern to search for', required: true },
      { name: 'path', type: 'string', description: 'Directory to search in', required: false },
    ],
    handler: async (params) => {
      const { execFileSync } = require('child_process');
      const searchDir = params.path ? path.resolve(params.path as string) : process.cwd();
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
