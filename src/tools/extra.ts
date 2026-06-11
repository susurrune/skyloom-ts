/**
 * Extended capability tools — fills out the agent's "use the whole computer"
 * surface: filesystem ops, hashing/encoding, networking, extended git, system
 * introspection, clipboard, and data querying.
 *
 * Every handler avoids the shell (execFileSync with argv arrays or native
 * modules), reuses the SSRF guard for outbound requests and the optional
 * workspace fence for filesystem paths, and returns a string. Danger levels are
 * declared in core/security.ts (TOOL_DANGER_MAP) so approval gating applies.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as net from 'net';
import * as zlib from 'zlib';
import { lookup } from 'dns/promises';
import { execFileSync } from 'child_process';
import type { ToolRegistry } from '../core/tool';
import { getLogger } from '../core/logger';
import { fenceCheck, assertFetchAllowed } from './guards';

const log = getLogger('extra-tools');
const MAX_OUT = 10000;
function clip(s: string, n = MAX_OUT): string {
  return s.length <= n ? s : s.slice(0, n) + `\n…(truncated, ${s.length - n} more chars)`;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { encoding: 'utf-8', cwd: cwd || process.cwd(), maxBuffer: 4 * 1024 * 1024 });
}

export function registerExtraTools(registry: ToolRegistry): void {
  const platform = os.platform();

  /* ════════════════ Filesystem ════════════════ */

  registry.register({
    name: 'copy_file',
    description: 'Copy a file (or directory tree) from source to destination.',
    parameters: [
      { name: 'source', type: 'string', description: 'Source path', required: true },
      { name: 'destination', type: 'string', description: 'Destination path', required: true },
    ],
    handler: async (params) => {
      const src = path.resolve(String(params.source || ''));
      const dest = path.resolve(String(params.destination || ''));
      const f1 = fenceCheck(src); if (f1) return f1;
      const f2 = fenceCheck(dest); if (f2) return f2;
      if (!fs.existsSync(src)) return `Error: source not found: ${src}`;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
        return `Copied ${src} → ${dest}`;
      } catch (e: any) { return `Error copying: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'move_file',
    description: 'Move or rename a file or directory.',
    parameters: [
      { name: 'source', type: 'string', description: 'Source path', required: true },
      { name: 'destination', type: 'string', description: 'Destination path', required: true },
    ],
    handler: async (params) => {
      const src = path.resolve(String(params.source || ''));
      const dest = path.resolve(String(params.destination || ''));
      const f1 = fenceCheck(src); if (f1) return f1;
      const f2 = fenceCheck(dest); if (f2) return f2;
      if (!fs.existsSync(src)) return `Error: source not found: ${src}`;
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.renameSync(src, dest);
        } catch {
          // cross-device fallback
          fs.cpSync(src, dest, { recursive: true });
          fs.rmSync(src, { recursive: true, force: true });
        }
        return `Moved ${src} → ${dest}`;
      } catch (e: any) { return `Error moving: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'make_directory',
    description: 'Create a directory (and any missing parents).',
    parameters: [{ name: 'path', type: 'string', description: 'Directory path to create', required: true }],
    handler: async (params) => {
      const dir = path.resolve(String(params.path || ''));
      const fenced = fenceCheck(dir); if (fenced) return fenced;
      try { fs.mkdirSync(dir, { recursive: true }); return `Created directory ${dir}`; }
      catch (e: any) { return `Error creating directory: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'append_file',
    description: 'Append content to the end of a file (creates it if missing).',
    parameters: [
      { name: 'path', type: 'string', description: 'File path', required: true },
      { name: 'content', type: 'string', description: 'Content to append', required: true },
    ],
    handler: async (params) => {
      const filePath = path.resolve(String(params.path || ''));
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, String(params.content ?? ''), 'utf-8');
        return `Appended ${Buffer.byteLength(String(params.content ?? ''), 'utf-8')} bytes to ${filePath}`;
      } catch (e: any) { return `Error appending: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'file_info',
    description: 'Get metadata for a file or directory: size, type, permissions, modified time.',
    parameters: [{ name: 'path', type: 'string', description: 'Path to inspect', required: true }],
    handler: async (params) => {
      const target = path.resolve(String(params.path || ''));
      const fenced = fenceCheck(target); if (fenced) return fenced;
      try {
        const s = fs.statSync(target);
        const kind = s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'file';
        return [
          `path: ${target}`,
          `type: ${kind}`,
          `size: ${s.size} bytes`,
          `mode: ${(s.mode & 0o777).toString(8)}`,
          `modified: ${s.mtime.toISOString()}`,
          `created: ${s.birthtime.toISOString()}`,
        ].join('\n');
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  /* ════════════════ Hashing / encoding (pure, read-only) ════════════════ */

  registry.register({
    name: 'hash',
    description: 'Compute a cryptographic hash of text or a file (md5, sha1, sha256, sha512).',
    parameters: [
      { name: 'text', type: 'string', description: 'Text to hash (omit if using path)', required: false },
      { name: 'path', type: 'string', description: 'File to hash (omit if using text)', required: false },
      { name: 'algorithm', type: 'string', description: 'md5 | sha1 | sha256 | sha512 (default sha256)', required: false },
    ],
    handler: async (params) => {
      const algo = String(params.algorithm || 'sha256').toLowerCase();
      if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) return `Error: unsupported algorithm '${algo}'`;
      try {
        let buf: Buffer;
        if (params.path != null) {
          const target = path.resolve(String(params.path));
          const fenced = fenceCheck(target); if (fenced) return fenced;
          buf = fs.readFileSync(target);
        } else {
          buf = Buffer.from(String(params.text ?? ''), 'utf-8');
        }
        return `${algo}: ${crypto.createHash(algo).update(buf).digest('hex')}`;
      } catch (e: any) { return `Error hashing: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'base64',
    description: 'Base64-encode or -decode text.',
    parameters: [
      { name: 'text', type: 'string', description: 'Text to encode/decode', required: true },
      { name: 'mode', type: 'string', description: 'encode | decode (default encode)', required: false },
    ],
    handler: async (params) => {
      const text = String(params.text ?? '');
      const mode = String(params.mode || 'encode').toLowerCase();
      try {
        if (mode === 'decode') return Buffer.from(text, 'base64').toString('utf-8');
        return Buffer.from(text, 'utf-8').toString('base64');
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'json_query',
    description: 'Parse JSON (from text or a file) and extract a value by dot path (e.g. "user.roles.0.name"). Omit path to validate/pretty-print.',
    parameters: [
      { name: 'json', type: 'string', description: 'JSON text (omit if using path)', required: false },
      { name: 'path', type: 'string', description: 'File containing JSON (omit if using json)', required: false },
      { name: 'query', type: 'string', description: 'Dot path into the data (optional)', required: false },
    ],
    handler: async (params) => {
      try {
        let raw: string;
        if (params.path != null) {
          const target = path.resolve(String(params.path));
          const fenced = fenceCheck(target); if (fenced) return fenced;
          raw = fs.readFileSync(target, 'utf-8');
        } else {
          raw = String(params.json ?? '');
        }
        let data: any = JSON.parse(raw);
        const q = String(params.query || '').trim();
        if (q) {
          for (const key of q.split('.').filter(Boolean)) {
            if (data == null || typeof data !== 'object') return `Error: path '${q}' not found (no '${key}')`;
            data = data[key];
          }
          if (data === undefined) return `Error: path '${q}' not found`;
        }
        return clip(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  /* ════════════════ Networking ════════════════ */

  registry.register({
    name: 'http_request',
    description: 'Make an HTTP request with any method, headers and body (POST/PUT/PATCH/DELETE/GET).',
    parameters: [
      { name: 'url', type: 'string', description: 'Target URL', required: true },
      { name: 'method', type: 'string', description: 'HTTP method (default GET)', required: false },
      { name: 'headers', type: 'object', description: 'Headers as a JSON object', required: false },
      { name: 'body', type: 'string', description: 'Request body', required: false },
    ],
    handler: async (params) => {
      try {
        await assertFetchAllowed(String(params.url || ''));
        const method = String(params.method || 'GET').toUpperCase();
        let headers: Record<string, string> | undefined;
        if (params.headers) {
          headers = typeof params.headers === 'string' ? JSON.parse(params.headers) : (params.headers as Record<string, string>);
        }
        const init: Record<string, any> = { method, headers };
        if (params.body != null && method !== 'GET' && method !== 'HEAD') init.body = String(params.body);
        const res = await fetch(String(params.url), init);
        const text = await res.text();
        return `Status: ${res.status} ${res.statusText}\n\n${clip(text)}`;
      } catch (e: any) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  });

  registry.register({
    name: 'download_file',
    description: 'Download a URL to a local file path.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to download', required: true },
      { name: 'path', type: 'string', description: 'Local destination path', required: true },
    ],
    handler: async (params) => {
      try {
        await assertFetchAllowed(String(params.url || ''));
        const dest = path.resolve(String(params.path || ''));
        const fenced = fenceCheck(dest); if (fenced) return fenced;
        const res = await fetch(String(params.url));
        if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;
        const buf = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        return `Downloaded ${buf.length} bytes → ${dest}`;
      } catch (e: any) { return `Error: ${e instanceof Error ? e.message : e}`; }
    },
  });

  registry.register({
    name: 'dns_lookup',
    description: 'Resolve a hostname to its IP addresses.',
    parameters: [{ name: 'host', type: 'string', description: 'Hostname to resolve', required: true }],
    handler: async (params) => {
      const host = String(params.host || '').trim();
      if (!host) return 'Error: host is required';
      try {
        const addrs = await lookup(host, { all: true });
        return addrs.map((a) => `${a.address} (IPv${a.family})`).join('\n') || 'No addresses found';
      } catch (e: any) { return `Error resolving ${host}: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'port_check',
    description: 'Check whether a TCP port is open on a host.',
    parameters: [
      { name: 'host', type: 'string', description: 'Host (default localhost)', required: false },
      { name: 'port', type: 'number', description: 'Port number', required: true },
    ],
    handler: async (params) => {
      const host = String(params.host || 'localhost').trim();
      const port = Math.floor(Number(params.port));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Error: invalid port';
      return await new Promise<string>((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (msg: string) => { if (done) return; done = true; sock.destroy(); resolve(msg); };
        sock.setTimeout(4000);
        sock.once('connect', () => finish(`open: ${host}:${port} is accepting connections`));
        sock.once('timeout', () => finish(`closed: ${host}:${port} timed out`));
        sock.once('error', (e: any) => finish(`closed: ${host}:${port} (${e.code || e.message})`));
        sock.connect(port, host);
      });
    },
  });

  /* ════════════════ Extended git ════════════════ */

  registry.register({
    name: 'git_add',
    description: 'Stage files for commit (git add). Pass "." to stage everything.',
    parameters: [{ name: 'paths', type: 'string', description: 'Space-separated paths, or "."', required: true }],
    handler: async (params) => {
      const paths = String(params.paths || '.').trim().split(/\s+/).filter(Boolean);
      try { git(['add', '--', ...paths]); return `Staged: ${paths.join(', ')}`; }
      catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'git_branch',
    description: 'List branches, or create a new branch when "name" is given.',
    parameters: [{ name: 'name', type: 'string', description: 'New branch name (omit to list)', required: false }],
    handler: async (params) => {
      const name = String(params.name || '').trim();
      try {
        if (name) { git(['branch', name]); return `Created branch ${name}`; }
        return clip(git(['branch', '-a', '--no-color']));
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'git_checkout',
    description: 'Switch to a branch/commit, or create+switch with new=true.',
    parameters: [
      { name: 'ref', type: 'string', description: 'Branch, tag or commit to check out', required: true },
      { name: 'new', type: 'boolean', description: 'Create the branch (git checkout -b)', required: false },
    ],
    handler: async (params) => {
      const ref = String(params.ref || '').trim();
      if (!ref) return 'Error: ref is required';
      try {
        git(params.new ? ['checkout', '-b', ref] : ['checkout', ref]);
        return `Checked out ${ref}`;
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'git_push',
    description: 'Push commits to a remote (default: current upstream).',
    parameters: [
      { name: 'remote', type: 'string', description: 'Remote name (default origin)', required: false },
      { name: 'branch', type: 'string', description: 'Branch to push (default current)', required: false },
    ],
    handler: async (params) => {
      const args = ['push'];
      if (params.remote) args.push(String(params.remote));
      if (params.branch) args.push(String(params.branch));
      try { return clip(git(args) || 'Pushed.'); }
      catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'git_pull',
    description: 'Pull and integrate changes from a remote.',
    parameters: [
      { name: 'remote', type: 'string', description: 'Remote name (default origin)', required: false },
      { name: 'branch', type: 'string', description: 'Branch to pull (default current)', required: false },
    ],
    handler: async (params) => {
      const args = ['pull'];
      if (params.remote) args.push(String(params.remote));
      if (params.branch) args.push(String(params.branch));
      try { return clip(git(args)); }
      catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  /* ════════════════ System / environment ════════════════ */

  registry.register({
    name: 'env_get',
    description: 'Read an environment variable, or list variable names when no name is given. Secret-looking values are redacted.',
    parameters: [{ name: 'name', type: 'string', description: 'Variable name (omit to list names)', required: false }],
    handler: async (params) => {
      const SECRET_RE = /KEY|TOKEN|SECRET|PASS|CRED|AUTH|PRIVATE/i;
      const name = String(params.name || '').trim();
      if (!name) return Object.keys(process.env).sort().join('\n');
      const val = process.env[name];
      if (val === undefined) return `(${name} is not set)`;
      return SECRET_RE.test(name) ? `${name}=<redacted (${val.length} chars)>` : `${name}=${val}`;
    },
  });

  registry.register({
    name: 'disk_usage',
    description: 'Report disk space (total/free/used) for the filesystem of a path.',
    parameters: [{ name: 'path', type: 'string', description: 'Path to inspect (default cwd)', required: false }],
    handler: async (params) => {
      const target = params.path ? path.resolve(String(params.path)) : process.cwd();
      try {
        const s: any = (fs as any).statfsSync(target);
        const total = s.blocks * s.bsize;
        const free = s.bfree * s.bsize;
        const gb = (n: number) => (n / 1024 ** 3).toFixed(2) + ' GB';
        return `path: ${target}\ntotal: ${gb(total)}\nfree: ${gb(free)}\nused: ${gb(total - free)} (${((1 - free / total) * 100).toFixed(1)}%)`;
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'clipboard_write',
    description: 'Copy text to the system clipboard.',
    parameters: [{ name: 'text', type: 'string', description: 'Text to copy', required: true }],
    handler: async (params) => {
      const text = String(params.text ?? '');
      try {
        if (platform === 'darwin') execFileSync('pbcopy', [], { input: text });
        else if (platform === 'win32') execFileSync('clip', [], { input: text });
        else {
          try { execFileSync('xclip', ['-selection', 'clipboard'], { input: text }); }
          catch { execFileSync('xsel', ['--clipboard', '--input'], { input: text }); }
        }
        return `Copied ${Buffer.byteLength(text, 'utf-8')} bytes to clipboard`;
      } catch (e: any) { return `Error (no clipboard utility?): ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'clipboard_read',
    description: 'Read the current text contents of the system clipboard.',
    parameters: [],
    handler: async () => {
      try {
        let out: string;
        if (platform === 'darwin') out = execFileSync('pbpaste', [], { encoding: 'utf-8' });
        else if (platform === 'win32') out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf-8' });
        else {
          try { out = execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf-8' }); }
          catch { out = execFileSync('xsel', ['--clipboard', '--output'], { encoding: 'utf-8' }); }
        }
        return clip(out);
      } catch (e: any) { return `Error (no clipboard utility?): ${e.message || e}`; }
    },
  });

  /* ════════════════ Developer utilities ════════════════ */

  registry.register({
    name: 'which',
    description: 'Locate an executable in PATH (like `which`/`where`). Tells you if a command is installed and where.',
    parameters: [{ name: 'name', type: 'string', description: 'Executable name to find', required: true }],
    handler: async (params) => {
      const name = String(params.name || '').trim();
      if (!name || /[\\/]/.test(name)) return 'Error: provide a bare command name (no path separators)';
      const exts = platform === 'win32'
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
      const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
      const hits: string[] = [];
      for (const dir of dirs) {
        for (const ext of exts) {
          const candidate = path.join(dir, name + ext);
          try { if (fs.statSync(candidate).isFile()) hits.push(candidate); } catch { /* not here */ }
        }
      }
      return hits.length ? hits.join('\n') : `${name}: not found in PATH`;
    },
  });

  registry.register({
    name: 'replace_in_file',
    description: 'Replace text in a file. Replaces ALL occurrences (unlike edit_file, which replaces only the first). Set regex=true to treat find as a regular expression.',
    parameters: [
      { name: 'path', type: 'string', description: 'File to edit', required: true },
      { name: 'find', type: 'string', description: 'Text (or regex) to search for', required: true },
      { name: 'replace', type: 'string', description: 'Replacement text', required: true },
      { name: 'regex', type: 'boolean', description: 'Treat find as a regular expression', required: false },
    ],
    handler: async (params) => {
      const filePath = path.resolve(String(params.path || ''));
      const fenced = fenceCheck(filePath); if (fenced) return fenced;
      if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
      try {
        const before = fs.readFileSync(filePath, 'utf-8');
        const find = String(params.find ?? '');
        const replace = String(params.replace ?? '');
        let after: string; let count = 0;
        if (params.regex) {
          let re: RegExp;
          try { re = new RegExp(find, 'g'); } catch (e: any) { return `Error: invalid regex — ${e.message || e}`; }
          after = before.replace(re, () => { count++; return replace; });
        } else {
          if (!find) return 'Error: find must be non-empty';
          count = before.split(find).length - 1;
          after = before.split(find).join(replace);
        }
        if (count === 0) return `No occurrences of the search text in ${filePath}`;
        fs.writeFileSync(filePath, after, 'utf-8');
        return `Replaced ${count} occurrence(s) in ${filePath}`;
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'diff_files',
    description: 'Show a unified diff between two files.',
    parameters: [
      { name: 'a', type: 'string', description: 'First (old) file path', required: true },
      { name: 'b', type: 'string', description: 'Second (new) file path', required: true },
    ],
    handler: async (params) => {
      const a = path.resolve(String(params.a || ''));
      const b = path.resolve(String(params.b || ''));
      const fa = fenceCheck(a); if (fa) return fa;
      const fb = fenceCheck(b); if (fb) return fb;
      for (const f of [a, b]) if (!fs.existsSync(f)) return `Error: file not found: ${f}`;
      try {
        // git diff --no-index exits 1 when files differ — that's the normal case.
        return clip(git(['diff', '--no-index', '--no-color', '--', a, b]) || '(files are identical)');
      } catch (e: any) {
        const out = (e.stdout || '').toString();
        return out ? clip(out) : `Error: ${e.message || e}`;
      }
    },
  });

  /* ════════════════ Compression ════════════════ */

  registry.register({
    name: 'gzip_file',
    description: 'Gzip-compress a file to <path>.gz (or a given destination).',
    parameters: [
      { name: 'path', type: 'string', description: 'File to compress', required: true },
      { name: 'destination', type: 'string', description: 'Output path (default: <path>.gz)', required: false },
    ],
    handler: async (params) => {
      const src = path.resolve(String(params.path || ''));
      const dest = path.resolve(String(params.destination || src + '.gz'));
      const f1 = fenceCheck(src); if (f1) return f1;
      const f2 = fenceCheck(dest); if (f2) return f2;
      if (!fs.existsSync(src)) return `Error: file not found: ${src}`;
      try {
        const out = zlib.gzipSync(fs.readFileSync(src));
        fs.writeFileSync(dest, out);
        return `Compressed ${src} → ${dest} (${out.length} bytes)`;
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  registry.register({
    name: 'gunzip_file',
    description: 'Decompress a .gz file.',
    parameters: [
      { name: 'path', type: 'string', description: '.gz file to decompress', required: true },
      { name: 'destination', type: 'string', description: 'Output path (default: strips .gz)', required: false },
    ],
    handler: async (params) => {
      const src = path.resolve(String(params.path || ''));
      const dest = path.resolve(String(params.destination || src.replace(/\.gz$/, '') || src + '.out'));
      const f1 = fenceCheck(src); if (f1) return f1;
      const f2 = fenceCheck(dest); if (f2) return f2;
      if (!fs.existsSync(src)) return `Error: file not found: ${src}`;
      try {
        const out = zlib.gunzipSync(fs.readFileSync(src));
        fs.writeFileSync(dest, out);
        return `Decompressed ${src} → ${dest} (${out.length} bytes)`;
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  /* ════════════════ Generators / time ════════════════ */

  registry.register({
    name: 'uuid',
    description: 'Generate a random UUID (v4).',
    parameters: [{ name: 'count', type: 'number', description: 'How many to generate (default 1)', required: false }],
    handler: async (params) => {
      const n = Math.max(1, Math.min(100, Math.floor(Number(params.count) || 1)));
      return Array.from({ length: n }, () => crypto.randomUUID()).join('\n');
    },
  });

  registry.register({
    name: 'random_string',
    description: 'Generate a cryptographically-random string.',
    parameters: [
      { name: 'length', type: 'number', description: 'Length in characters (default 32)', required: false },
      { name: 'encoding', type: 'string', description: 'hex | base64 | base64url (default hex)', required: false },
    ],
    handler: async (params) => {
      const len = Math.max(1, Math.min(4096, Math.floor(Number(params.length) || 32)));
      const enc = String(params.encoding || 'hex').toLowerCase();
      if (!['hex', 'base64', 'base64url'].includes(enc)) return `Error: unsupported encoding '${enc}'`;
      return crypto.randomBytes(len).toString(enc as BufferEncoding).slice(0, len);
    },
  });

  registry.register({
    name: 'current_time',
    description: 'Get the current date and time (ISO UTC, local, epoch ms, timezone).',
    parameters: [],
    handler: async () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return [
        `iso_utc: ${now.toISOString()}`,
        `local: ${now.toString()}`,
        `epoch_ms: ${now.getTime()}`,
        `timezone: ${tz}`,
      ].join('\n');
    },
  });

  /* ════════════════ Databases ════════════════ */

  registry.register({
    name: 'sqlite_query',
    description: 'Run SQL against a SQLite database file. Read-only by default (SELECT/PRAGMA); set allow_write=true to permit INSERT/UPDATE/DELETE/DDL. Tip: list tables with "SELECT name FROM sqlite_master WHERE type=\'table\'".',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the .db / .sqlite file', required: true },
      { name: 'sql', type: 'string', description: 'SQL statement to execute', required: true },
      { name: 'allow_write', type: 'boolean', description: 'Permit data-modifying / DDL statements (default false)', required: false },
    ],
    handler: async (params) => {
      const file = path.resolve(String(params.path || ''));
      const fenced = fenceCheck(file); if (fenced) return fenced;
      if (!fs.existsSync(file)) return `Error: database not found: ${file}`;
      const sql = String(params.sql || '').trim();
      if (!sql) return 'Error: sql is required';
      const writeRe = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|TRUNCATE|ATTACH|DETACH|VACUUM)\b/i;
      if (!params.allow_write && writeRe.test(sql)) {
        return 'Error: write/DDL statement blocked — set allow_write=true to permit modifications';
      }
      try {
        const SQL = await getSqlJs();
        const db = new SQL.Database(fs.readFileSync(file));
        try {
          const res = db.exec(sql); // [{ columns, values }] for the statements run
          if (params.allow_write) fs.writeFileSync(file, Buffer.from(db.export()));
          if (!res.length) return params.allow_write ? 'OK (no rows returned)' : '(no rows)';
          const { columns, values } = res[res.length - 1];
          const rows = values.slice(0, 200).map((r: any[]) =>
            Object.fromEntries(columns.map((c: string, i: number) => [c, r[i]])));
          const more = values.length > 200 ? `\n…(${values.length - 200} more rows)` : '';
          return clip(JSON.stringify(rows, null, 2)) + more;
        } finally { db.close(); }
      } catch (e: any) { return `Error: ${e.message || e}`; }
    },
  });

  log.info('extra_tools_registered');
}

/** Lazily-initialised sql.js runtime (wasm), shared across calls. */
let _sqlJs: any = null;
async function getSqlJs(): Promise<any> {
  if (!_sqlJs) {
    const mod = require('sql.js');
    _sqlJs = await (mod.default || mod)();
  }
  return _sqlJs;
}
