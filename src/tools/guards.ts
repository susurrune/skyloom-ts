/**
 * Shared safety guards for tool handlers: SSRF protection for outbound fetches
 * and the optional workspace fence for filesystem tools. Kept in their own
 * module so both builtin.ts and extra.ts can use them without a circular import.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { lookup } from 'dns/promises';

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/* ── SSRF guard for outbound fetches ──────────────────────────────────────
   Auto-approved/low-danger fetch tools must not be able to pivot to internal
   services / cloud metadata (169.254.169.254). We block private, loopback and
   link-local targets — both when the URL is an IP literal and after DNS
   resolution. Operators who need internal hosts set SKYLOOM_ALLOW_PRIVATE_FETCH=1.
   ────────────────────────────────────────────────────────────────────────── */
export function isPrivateIPv4(ip: string): boolean {
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

export function isPrivateIp(ip: string): boolean {
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

export async function assertFetchAllowed(rawUrl: string): Promise<void> {
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

/** Fetch with SSRF checks on the initial URL and every redirect target. */
export async function safeFetch(
  rawUrl: string,
  init: FetchInit = {},
  opts: { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<FetchResponse> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);

  let current = new URL(rawUrl);
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body;
  const headers = new globalThis.Headers(init.headers);

  try {
    for (let redirects = 0; ; redirects++) {
      await assertFetchAllowed(current.href);
      const response = await fetch(current, {
        ...init,
        method,
        body,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;

      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects >= maxRedirects) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`too many redirects (>${maxRedirects})`);
      }

      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete('proxy-authorization');
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-length');
        headers.delete('content-type');
      }
      await response.body?.cancel().catch(() => undefined);
      current = next;
    }
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

/** Decode a response body without buffering an unbounded payload in memory. */
export async function readResponseText(response: FetchResponse, maxBytes = 1024 * 1024): Promise<string> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`response body exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response body exceeds ${maxBytes} byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/* ── Optional workspace fence for file tools ──────────────────────────────
   Off by default (the agent is a Claude-Code-style assistant that legitimately
   works across a repo). Set SKYLOOM_WORKSPACE_FENCE=1 to confine file tools to
   a root directory (SKYLOOM_WORKSPACE_ROOT, or the process cwd), blocking
   traversal to ~/.ssh, /etc, etc.
   ────────────────────────────────────────────────────────────────────────── */
export function fenceRoot(): string | null {
  if (process.env.SKYLOOM_WORKSPACE_FENCE !== '1') return null;
  const raw = process.env.SKYLOOM_WORKSPACE_ROOT;
  return raw ? path.resolve(raw.replace(/^~(?=$|\/|\\)/, os.homedir())) : process.cwd();
}

/** Returns an error string if `resolvedPath` is outside the fence, else null. */
export function fenceCheck(resolvedPath: string): string | null {
  const root = fenceRoot();
  if (!root) return null;
  const canonicalize = (target: string): string => {
    let existing = path.resolve(target);
    const missing: string[] = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    let canonical = existing;
    try { canonical = fs.realpathSync.native(existing); } catch { /* preserve resolved fallback */ }
    return path.resolve(canonical, ...missing);
  };
  const canonicalRoot = canonicalize(root);
  const canonicalTarget = canonicalize(resolvedPath);
  const rel = path.relative(canonicalRoot, canonicalTarget);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return null;
  return `Error: 路径越界 — 工作区围栏已启用 (SKYLOOM_WORKSPACE_FENCE=1)，'${resolvedPath}' 的真实路径在根目录 '${root}' 之外。`;
}
