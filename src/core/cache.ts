/**
 * Lightweight LRU cache for LLM responses.
 *
 * Deduplicates identical requests within a configurable time window.
 * Keyed by (model, messages_json) hash.
 */

import crypto from 'crypto';

/**
 * Cache entry containing timestamp and response.
 */
interface CacheEntry {
  timestamp: number;
  response: string;
}

/**
 * LRU cache for LLM completions with TTL expiration.
 */
export class LLMCache {
  private maxSize: number;
  private ttlSeconds: number;
  private cache: Map<string, CacheEntry> = new Map();

  constructor(maxSize: number = 128, ttlSeconds: number = 60) {
    this.maxSize = maxSize;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Generate a cache key from model, messages, and parameters.
   *
   * Uses SHA256 hash for deterministic, compact keys. Parameters are sorted
   * to ensure consistent keys regardless of key order.
   */
  private makeKey(
    model: string,
    messages: Record<string, any>[],
    params?: Record<string, any>
  ): string {
    const raw = JSON.stringify([model, messages, params || {}], this.jsonReplacer);
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  /**
   * JSON replacer for consistent serialization.
   */
  private jsonReplacer(_key: string, value: any): any {
    if (typeof value === 'function') {
      return undefined;
    }
    return value;
  }

  /**
   * Get a cached response if it exists and hasn't expired.
   *
   * @param model - LLM model name
   * @param messages - Conversation messages
   * @param params - Optional parameters
   * @returns Cached response or null if miss/expired
   */
  get(
    model: string,
    messages: Record<string, any>[],
    params?: Record<string, any>
  ): string | null {
    const key = this.makeKey(model, messages, params);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    const now = Date.now();
    const ageSeconds = (now - entry.timestamp) / 1000;

    if (ageSeconds >= this.ttlSeconds) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.response;
  }

  /**
   * Cache a response.
   *
   * Refuses to cache empty or very short content to avoid bloat.
   * Also performs LRU eviction if cache exceeds max_size.
   *
   * @param model - LLM model name
   * @param messages - Conversation messages
   * @param response - LLM response to cache
   * @param params - Optional parameters
   */
  set(
    model: string,
    messages: Record<string, any>[],
    response: string,
    params?: Record<string, any>
  ): void {
    // Don't cache empty or very short responses
    if (!response || response.length < 10) {
      return;
    }

    const key = this.makeKey(model, messages, params);
    const entry: CacheEntry = {
      timestamp: Date.now(),
      response,
    };

    this.cache.delete(key);
    this.cache.set(key, entry);

    // Evict oldest entries if over capacity
    while (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache hit rate statistics.
   */
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }
}
