/**
 * Shared helpers for channel adapters: secret resolution (config value or env
 * fallback), and a tiny JSON HTTP client. Kept dependency-light (axios is
 * already a project dep) and injectable-free — adapters call these directly.
 */

import axios from 'axios';
import * as path from 'path';
import { safeFetch } from '../tools/guards';

const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

/**
 * Resolve a secret/config value. Accepts a literal string, or an env-ref object
 * `{ source: 'env', id: 'NAME' }` (OpenClaw-compatible), falling back to the
 * given env var name. Returns undefined if unresolved.
 */
export function resolveSecret(
  value: unknown,
  env: NodeJS.ProcessEnv,
  envFallback?: string,
): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const v = value as any;
    if (v.source === 'env' && typeof v.id === 'string') {
      const got = env[v.id];
      if (got && got.trim()) return got.trim();
    }
  }
  if (envFallback) {
    const got = env[envFallback];
    if (got && got.trim()) return got.trim();
  }
  return undefined;
}

/** POST JSON, return parsed JSON. Throws on non-2xx. */
export async function postJson(
  url: string,
  body: any,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<any> {
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', ...(opts?.headers || {}) },
    timeout: opts?.timeoutMs ?? 15000,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return res.data;
}

/** GET JSON, return parsed JSON. Throws on non-2xx. */
export async function getJson(
  url: string,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<any> {
  const res = await axios.get(url, {
    headers: { Accept: 'application/json', ...(opts?.headers || {}) },
    timeout: opts?.timeoutMs ?? 15000,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return res.data;
}

/** A loaded binary plus its filename, ready to upload. */
export interface LoadedMedia {
  data: Buffer;
  filename: string;
  contentType?: string;
}

/**
 * Load outbound media from a public http(s) URL. Local paths are deliberately
 * rejected: agent-authored replies must not become an arbitrary file-read
 * channel. Redirects and resolved addresses pass through the shared SSRF guard.
 */
export async function loadMedia(src: string): Promise<LoadedMedia> {
  if (!isSendableSrc(src)) throw new Error('outbound media must use a public http(s) URL');
  const res = await safeFetch(src, {}, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`media request failed with HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte limit`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`media exceeds ${MAX_MEDIA_BYTES} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return {
    data: Buffer.concat(chunks),
    filename: path.basename(new URL(src).pathname) || 'file',
    contentType: res.headers.get('content-type') || undefined,
  };
}

/** Local filesystem references are never sendable from agent-authored replies. */
export function isSendableSrc(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** POST multipart/form-data (Node 18+ FormData/Blob), return parsed JSON. */
export async function postMultipart(
  url: string,
  fields: Record<string, string | { data: Buffer; filename: string; contentType?: string }>,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') form.append(k, v);
    else form.append(k, new Blob([v.data], v.contentType ? { type: v.contentType } : undefined), v.filename);
  }
  const res = await axios.post(url, form, {
    headers: { ...(opts?.headers || {}) },
    timeout: opts?.timeoutMs ?? 30000,
    maxBodyLength: Infinity,
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return res.data;
}

/**
 * A small token cache: fetch an access token via `fetcher`, cache it until it
 * is near expiry, and refresh transparently. Channels (Feishu/WeCom) all need
 * a short-lived tenant/access token; this avoids re-fetching per message.
 */
export class TokenCache {
  private token: string | null = null;
  private expiresAt = 0;
  constructor(private fetcher: () => Promise<{ token: string; expiresInSec: number }>) {}

  async get(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.expiresAt - 60_000) return this.token;
    const { token, expiresInSec } = await this.fetcher();
    this.token = token;
    this.expiresAt = now + Math.max(60, expiresInSec) * 1000;
    return token;
  }

  /** Force the next get() to refetch (e.g. after a 401). */
  invalidate(): void { this.token = null; this.expiresAt = 0; }
}
