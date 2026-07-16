import { timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';

export const MIN_WEB_TOKEN_LENGTH = 24;

export interface WebAccessPolicy {
  host: string;
  loopbackOnly: boolean;
  token: string | null;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

export function resolveWebAccessPolicy(host: string, token?: string): WebAccessPolicy {
  const normalizedHost = host.trim() || '127.0.0.1';
  const loopbackOnly = isLoopbackHost(normalizedHost);
  if (loopbackOnly) return { host: normalizedHost, loopbackOnly: true, token: null };

  const secret = token || '';
  if (secret.length < MIN_WEB_TOKEN_LENGTH) {
    throw new Error(
      `Refusing non-loopback Skyloom Web binding without SKYLOOM_WEB_TOKEN ` +
      `(minimum ${MIN_WEB_TOKEN_LENGTH} characters).`,
    );
  }
  return { host: normalizedHost, loopbackOnly: false, token: secret };
}

function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function basicPassword(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0 || decoded.slice(0, separator) !== 'skyloom') return null;
    return decoded.slice(separator + 1);
  } catch {
    return null;
  }
}

export function isAuthorizedWebRequest(headers: IncomingHttpHeaders, expectedToken: string): boolean {
  const explicit = headers['x-skyloom-token'];
  const headerToken = Array.isArray(explicit) ? explicit[0] : explicit;
  if (headerToken && sameSecret(expectedToken, headerToken)) return true;

  const authorization = headers.authorization || '';
  const separator = authorization.indexOf(' ');
  if (separator < 0) return false;
  const scheme = authorization.slice(0, separator).toLowerCase();
  const value = authorization.slice(separator + 1).trim();
  if (scheme === 'bearer') return sameSecret(expectedToken, value);
  if (scheme === 'basic') {
    const password = basicPassword(value);
    return password !== null && sameSecret(expectedToken, password);
  }
  return false;
}
