/**
 * Built-in tool registration — registers all default tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolRegistry } from '../core/tool';
import { getLogger } from '../core/logger';

const log = getLogger('builtin-tools');

/**
 * Register all built-in tools into the given registry.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  // ── File Tools ──

  registry.register({
    name: 'read_file',
    description: 'Read the contents of a file at the given path. Use this to inspect files, check file contents, or verify writes.',
    parameters: [
      { name: 'path', type: 'string', description: 'Absolute or relative path to the file', required: true },
    ],
    handler: async (params) => {
      const filePath = path.resolve(params.path as string);
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return `Successfully read ${filePath} (${content.length} chars):\n${content}`;
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
      const { execSync } = require('child_process');
      const cmd = params.command as string;
      const timeout = (params.timeout as number) || 30000;
      try {
        const result = execSync(cmd, { encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 });
        return result || '(command produced no output)';
      } catch (e: any) {
        return `Error: ${e.message || e}`;
      }
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
        const response = await fetch(params.url as string);
        const text = await response.text();
        return `Status: ${response.status}\n\n${text.slice(0, 10000)}${text.length > 10000 ? '\n...[truncated]' : ''}`;
      } catch (e) {
        return `Error fetching URL: ${e}`;
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
      const { execSync } = require('child_process');
      try {
        const n = (params.max_count as number) || 10;
        return execSync(`git log --oneline -${n}`, { encoding: 'utf-8' });
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
      const { execSync } = require('child_process');
      try {
        const msg = params.message as string;
        execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
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
      const { execSync } = require('child_process');
      const searchDir = params.path ? path.resolve(params.path as string) : process.cwd();
      const pat = String(params.pattern || '');
      try {
        const out = execSync('rg -n ' + pat + ' ' + searchDir + ' 2>/dev/null || grep -rn ' + pat + ' ' + searchDir + ' 2>/dev/null || echo "No matches found"', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        return out;
      } catch {
        return 'No matches found.';
      }
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
      const { execSync } = require('child_process');
      const treeDir = params.directory ? path.resolve(params.directory as string) : process.cwd();
      const depth = (params.depth as number) || 3;
      try {
        const out = execSync('tree "' + treeDir + '" -L ' + depth + ' --charset=utf-8 2>/dev/null || echo "tree unavailable"', { encoding: 'utf-8' });
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
