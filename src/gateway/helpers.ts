/**
 * Shared helpers for channel adapters: secret resolution (config value or env
 * fallback), and a tiny JSON HTTP client. Kept dependency-light (axios is
 * already a project dep) and injectable-free — adapters call these directly.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

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
 * Load media bytes from a local filesystem path or an http(s) URL. Local paths
 * are read directly; remote URLs are fetched (capped at 30 MiB to avoid
 * pulling something huge into memory). Throws if the source can't be loaded.
 */
export async function loadMedia(src: string): Promise<LoadedMedia> {
  if (/^https?:\/\//i.test(src)) {
    const res = await axios.get(src, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 30 * 1024 * 1024,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const urlName = path.basename(new URL(src).pathname) || 'file';
    const ct = res.headers['content-type'];
    return {
      data: Buffer.from(res.data),
      filename: urlName,
      contentType: typeof ct === 'string' ? ct : undefined,
    };
  }
  const data = fs.readFileSync(src); // throws ENOENT if missing — caller handles
  return { data, filename: path.basename(src) };
}

/** Is this a sendable media source (http(s) URL or an existing local file)? */
export function isSendableSrc(src: string): boolean {
  if (/^https?:\/\//i.test(src)) return true;
  try { return fs.existsSync(src) && fs.statSync(src).isFile(); } catch { return false; }
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
