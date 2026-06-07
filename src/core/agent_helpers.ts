/**
 * Module-level helpers for core/agent — parsing, signatures, similarity, labels.
 *
 * Pure functions / constants only: no state, no agent reference, safe to import anywhere.
 */

import crypto from 'crypto';
import type { Message } from './memory';
import type { ToolRegistry } from './tool';

// ── Tool labels ──

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading {path}',
  write_file: 'Writing {path}',
  edit_file: 'Editing {path}',
  list_directory: 'Listing {path}',
  file_search: 'Searching {directory}/{pattern}',
  code_search: "Searching for '{query}'",
  grep: "Grepping '{pattern}'",
  shell_exec: 'Running: {command}',
  http_get: 'GET {url}',
  http_post: 'POST {url}',
  web_search: 'Searching: {query}',
  move_file: 'Moving {src}',
  copy_file: 'Copying {src}',
  delete_file: 'Deleting {path}',
  get_cwd: 'Getting working directory',
  tree: 'Tree {directory}',
  lint_file: 'Linting {path}',
  scan_deps: 'Scanning {directory}',
  fetch_page: 'Fetching {url}',
  delegate_to: 'Delegating to {agent}: {task}',
  use_skill: 'Activating {name}',
  list_skills: 'Listing available skills',
  git_status: 'Git status',
  git_diff: 'Git diff',
  git_log: 'Git log',
  git_add: 'Git add {files}',
  git_commit: 'Git commit',
  git_checkout: 'Git checkout {branch}',
  launch_app: 'Launching {name}',
  open_path: 'Opening {target}',
  browser_open: 'Opening {url} in browser',
  list_installed_apps: 'Listing installed apps',
  system_info: 'System info',
  system_diagnose: 'System diagnosis',
  list_processes: 'Listing processes',
  kill_process: 'Killing {target}',
  package_manager: 'Package {action} {name}',
  service_control: 'Service {action} {name}',
  mcp_list_servers: 'Listing MCP servers',
  mcp_add_server: 'Adding MCP server {name}',
  mcp_remove_server: 'Removing MCP server {name}',
  mcp_scaffold_server: 'Scaffolding MCP server {name}',
  remember: 'Remembering: {note}',
};

// ── Regex patterns ──

const RE_OBJ_OR_ARRAY = /(\{.*\}|\[.*\])/s;
const RE_KV_DETECT = /\b\w[\w\d_]*\s*=/;
const RE_KV_PAIRS = /(\w[\w\d_]*)\s*=\s*("[^"]*"|'[^']*'|[\w\d_.+-]+)/g;
const RE_NONE_LITERAL = /:\s*None\s*([,}])/g;
const RE_TRUE_LITERAL = /:\s*True\s*([,}])/g;
const RE_FALSE_LITERAL = /:\s*False\s*([,}])/g;
const RE_PY_NONE = /\bNone\b/g;
const RE_PY_TRUE = /\bTrue\b/g;
const RE_PY_FALSE = /\bFalse\b/g;
const RE_UNQUOTED_KEY = /([{,]\s*)(\w[\w\d_]*)(\s*:)/g;
const RE_TRAILING_COMMA = /,\s*([}\]])/g;
const RE_UNQUOTED_STRING = /(:\s*)([a-zA-Z_.][a-zA-Z0-9_ ./\\@.\-+#~$]*?)(\s*[,}\]])/g;

// ── Tool-signature loop detector tuning ──
export const SIG_WINDOW = 8;
export const SIG_LOOP_HINT = 4;
export const SIG_LOOP_HARDSTOP = 6;

// ── Tool-failure markers ──
const TOOL_FAILURE_MARKERS = [
  'no results found',
  'no matches for',
  'file not found',
  'directory not found',
  'permission denied',
  'status: 4',
  'status: 5',
  'request timed out',
  'timed out',
  'connection refused',
  'name or service not known',
  'ssl',
  '[error',
  'error: tool',
  'error: file',
  'error: directory',
  'circuitbreakeropen',
  'execution failed:',
];

// ── File-producing tools ──
const FILE_PRODUCING_TOOLS: Record<string, string[]> = {
  write_file: ['path'],
  edit_file: ['path'],
  copy_file: ['dst', 'destination'],
  move_file: ['dst', 'destination'],
};

// ── Functions ──

/**
 * Parse tool call JSON with multi-stage repair for LLM output quirks.
 */
export function parseToolArgs(raw: string): Record<string, any> | null {
  if (!raw || !raw.trim()) return null;

  let cleaned = raw.trim();

  // 1. Direct parse
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // 2. Strip markdown code fences
  if (cleaned.startsWith('```')) {
    const nl = cleaned.indexOf('\n');
    if (nl >= 0) cleaned = cleaned.slice(nl + 1);
    const end = cleaned.lastIndexOf('```');
    if (end >= 0) cleaned = cleaned.slice(0, end);
    cleaned = cleaned.trim();
    try { return JSON.parse(cleaned); } catch { /* continue */ }
  }

  // 3. Extract first JSON object/array from surrounding text
  const objMatch = RE_OBJ_OR_ARRAY.exec(cleaned);
  if (objMatch) {
    cleaned = objMatch[1];
    try { return JSON.parse(cleaned); } catch { /* continue */ }
  }

  // 4. Key=value format: query="weather", count=5 -> {"query": "weather", "count": 5}
  if (!cleaned.startsWith('{') && RE_KV_DETECT.test(cleaned)) {
    const kvPairs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = RE_KV_PAIRS.exec(cleaned)) !== null) {
      const key = m[1];
      let val = m[2];
      if (val.startsWith("'") && val.endsWith("'")) {
        val = '"' + val.slice(1, -1) + '"';
      }
      kvPairs.push(`"${key}": ${val}`);
    }
    if (kvPairs.length > 0) {
      let jsonStr = '{' + kvPairs.join(', ') + '}';
      jsonStr = jsonStr.replace(RE_NONE_LITERAL, ': null$1');
      jsonStr = jsonStr.replace(RE_TRUE_LITERAL, ': true$1');
      jsonStr = jsonStr.replace(RE_FALSE_LITERAL, ': false$1');
      try { return JSON.parse(jsonStr); } catch { /* continue */ }
    }
  }

  // 5. Python -> JSON literals
  cleaned = cleaned.replace(RE_PY_NONE, 'null');
  cleaned = cleaned.replace(RE_PY_TRUE, 'true');
  cleaned = cleaned.replace(RE_PY_FALSE, 'false');

  // 6. Backtick -> double quote
  cleaned = cleaned.replace(/`/g, '"');

  // 7. Fix single-quote strings
  if (cleaned.includes("'")) {
    cleaned = cleaned.replace(/'/g, '"');
  }

  // 8. Fix unquoted keys
  cleaned = cleaned.replace(RE_UNQUOTED_KEY, '$1"$2"$3');

  // 9. Fix trailing commas
  cleaned = cleaned.replace(RE_TRAILING_COMMA, '$1');
  cleaned = cleaned.replace(/,\s*$/, '').trim();

  // 10. Fix unquoted string values
  cleaned = cleaned.replace(RE_UNQUOTED_STRING, (match, prefix: string, word: string, suffix: string) => {
    if (word === 'null' || word === 'true' || word === 'false') return match;
    if (/^-?\d+(\.\d+)?$/.test(word)) return match;
    if (word.startsWith('"') || word.startsWith('{') || word.startsWith('[')) return match;
    return `${prefix}"${word}"${suffix}`;
  });

  // 11. Attempt parse
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // 12. Balanced-brace extraction
  let depth = 0;
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { /* continue */ }
      }
    }
  }

  // Auto-close unclosed braces
  if (start >= 0 && depth > 0) {
    const candidate = cleaned.slice(start) + '}'.repeat(depth);
    try { return JSON.parse(candidate); } catch { /* ignore */ }
  }

  return null;
}

/**
 * Heuristic: does this tool result indicate a dead-end the LLM should stop retrying?
 */
export function looksLikeFailedToolResult(result: string): boolean {
  if (!result) return true;
  const head = result.slice(0, 300).toLowerCase();
  return TOOL_FAILURE_MARKERS.some(m => head.includes(m));
}

/**
 * Walk assistant turns and pull out file paths that write_file / edit_file / etc. touched.
 */
export function extractFilePathsFromMessages(messages: Message[]): string[] {
  const toolResults: Record<string, string> = {};
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      toolResults[m.toolCallId] = m.content || '';
    }
  }

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      const name = tc.function?.name || '';
      const argKeys = FILE_PRODUCING_TOOLS[name];
      if (!argKeys) continue;

      const raw = tc.function?.arguments || '';
      let args: Record<string, any>;
      try {
        args = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch {
        continue;
      }
      if (typeof args !== 'object') continue;

      let filePath: string | undefined;
      for (const k of argKeys) {
        const v = args[k];
        if (typeof v === 'string' && v.trim()) {
          filePath = v.trim();
          break;
        }
      }
      if (!filePath) continue;

      const result = toolResults[tc.id || ''] || '';
      if (result && (result.startsWith('Error:') || result.startsWith('[Error'))) continue;
      if (!seen.has(filePath)) {
        seen.add(filePath);
        paths.push(filePath);
      }
    }
  }
  return paths;
}

/**
 * Append a deterministic artifact footer when the agent wrote files during this task.
 */
export function enrichResponseWithArtifacts(content: string, filePaths: string[]): string {
  if (!filePaths.length) return content;
  const body = content || '';
  const missing = filePaths.filter(p => !body.includes(p));
  if (!missing.length) return body;

  const lines = ['', '> **Artifacts produced**'];
  for (const p of filePaths) {
    const marker = body.includes(p) ? ' — already cited above' : '';
    lines.push(`> - \`${p}\`${marker}`);
  }
  return body.trimEnd() + '\n\n' + lines.join('\n');
}

/**
 * Compact, stable fingerprint of a tool call for loop detection.
 */
export function toolCallSignature(toolName: string, args: Record<string, any> | null): string {
  const a = args || {};

  if (toolName === 'edit_file') {
    const osVal = (a.old_text as string) || (a.oldText as string) || '';
    if (osVal) {
      const hash = crypto.createHash('sha1').update(osVal).digest('hex').slice(0, 8);
      return `edit_file:${a.path || ''}#${hash}`;
    }
    return `edit_file:${a.path || ''}`;
  }
  if (['write_file', 'read_file', 'delete_file'].includes(toolName)) {
    return `${toolName}:${a.path || ''}`;
  }
  if (['copy_file', 'move_file'].includes(toolName)) {
    return `${toolName}:${a.src || a.source || ''}->${a.dst || a.destination || ''}`;
  }
  if (['run_bash', 'bash', 'shell', 'run_shell'].includes(toolName)) {
    const cmd = (a.command || a.cmd || '') as string;
    if (!cmd) return toolName;
    const first = cmd.split(/\s+/)[0] || '';
    return `${toolName}:${first.slice(0, 30)}`;
  }
  if (['web_search', 'search', 'search_web', 'search_files', 'grep'].includes(toolName)) {
    let q = ((a.query || a.pattern || '') as string).slice(0, 40);
    q = q.replace(/[\s"'「」『』""''‘’“”]/g, '');
    return `${toolName}:${q.toLowerCase().slice(0, 30)}`;
  }
  if (['fetch_page', 'fetch_web_page', 'http_get', 'http_post'].includes(toolName)) {
    return `${toolName}:${(a.url || '').slice(0, 60)}`;
  }
  if (toolName === 'delegate_to') {
    return `delegate_to:${a.agent || ''}`;
  }

  // Generic fallback
  if (Object.keys(a).length > 0) {
    const blob = JSON.stringify(a, Object.keys(a).sort());
    const hash = crypto.createHash('sha1').update(blob.slice(0, 300)).digest('hex').slice(0, 8);
    return `${toolName}:${hash}`;
  }
  return toolName;
}

/**
 * Cheap similarity for narration-loop detection.
 */
export function textSimilarity(a: string, b: string): number {
  if (a.length < 12 || b.length < 12) return 0.0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;

  if (longer.length === 0) return 0.0;

  // Use simple character overlap as a cheap similarity measure
  const common = [...shorter].filter(ch => longer.includes(ch)).length;
  return common / longer.length;
}

/**
 * Produce a tool-result error string that helps the LLM recover.
 */
export function formatArgsParseError(toolName: string, rawArgs: string): string {
  const stripped = rawArgs.trimEnd();
  const hasClosingBrace = stripped.endsWith('}') || stripped.endsWith(']');

  // Crude quote counter
  let inString = false;
  let i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '\\' && inString) { i += 2; continue; }
    if (ch === '"') inString = !inString;
    i++;
  }
  const looksTruncated = inString || !hasClosingBrace;
  const preview = rawArgs.slice(0, 200) + (rawArgs.length > 200 ? '...[truncated]' : '');

  if (looksTruncated) {
    return (
      `Error: tool '${toolName}' arguments were truncated by the model's ` +
      `output budget (max_tokens). The JSON ended mid-value so it cannot ` +
      `be parsed. For large content, split into multiple smaller calls. ` +
      `Args preview: ${preview}`
    );
  }
  return `Error: invalid JSON in tool call arguments for '${toolName}': ${preview}`;
}

/**
 * Return the closest existing tool names for a hallucinated name.
 */
export function suggestToolNames(missing: string, registry: ToolRegistry, maxN: number = 3): string[] {
  const allNames = registry.listNames();
  if (!allNames.length) return [];

  const missingLower = missing.toLowerCase();
  const missingChunks = missingLower.split('_').filter(c => c.length >= 3);

  // Score by name overlap
  const scored: Array<{ name: string; score: number }> = [];
  const descScored: Array<{ name: string; score: number }> = [];

  for (const n of allNames) {
    const nlow = n.toLowerCase();
    let nameScore = 0;
    for (const chunk of missingChunks) {
      if (nlow.includes(chunk)) nameScore += 2;
    }
    for (const chunk of nlow.split('_')) {
      if (chunk.length >= 3 && missingLower.includes(chunk)) nameScore += 1;
    }
    if (nameScore > 0) {
      scored.push({ name: n, score: nameScore });
    }

    const tool = registry.get(n);
    if (!tool) continue;
    const desc = tool.description.toLowerCase();
    const descScore = missingChunks.filter(ch => desc.includes(ch)).length;
    if (descScore > 0) {
      descScored.push({ name: n, score: descScore });
    }
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxN).map(s => s.name);
  }
  descScored.sort((a, b) => b.score - a.score);
  return descScored.slice(0, maxN).map(s => s.name);
}

/**
 * Build a human-readable one-liner for a tool call.
 */
export function toolStatusLabel(name: string, args: Record<string, any>): string {
  const template = TOOL_LABELS[name];
  let label: string;
  if (template) {
    try {
      label = template.replace(/\{(\w+)\}/g, (_m, key) => String(args[key] ?? ''));
    } catch {
      label = `${name}...`;
    }
  } else {
    label = `${name}...`;
  }
  if (label.length > 100) {
    label = label.slice(0, 97) + '...';
  }
  return label;
}

/**
 * Build a short fallback line shown when a turn ends with delegate_to calls but no plain text.
 */
export function synthesizeDelegationSummary(delegations: Array<[string, boolean]>): string {
  if (!delegations.length) return '';
  const ok = delegations.filter(([_, s]) => s).map(([n]) => n);
  const failed = delegations.filter(([_, s]) => !s).map(([n]) => n);
  const parts: string[] = [];
  if (ok.length) parts.push('Delegated: ' + ok.join(', '));
  if (failed.length) parts.push('Failed: ' + failed.join(', '));
  return '[' + parts.join(' | ') + ']';
}
