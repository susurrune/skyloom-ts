/**
 * Shared helpers for channel adapters: secret resolution (config value or env
 * fallback), and a tiny JSON HTTP client. Kept dependency-light (axios is
 * already a project dep) and injectable-free — adapters call these directly.
 */

import axios from 'axios';

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
