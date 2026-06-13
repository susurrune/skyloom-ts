/**
 * Tool registration and execution framework with retry support
 */

import { EventEmitter } from "events";
import { getLogger } from "./logger";
import { CircuitBreaker } from "./circuit_breaker";

const log = getLogger("tool");

/**
 * Tool parameter definition
 */
export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}

/**
 * Tool handler function
 */
export type ToolHandler = (params: Record<string, unknown>) => Promise<string>;

/**
 * Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: ToolParameter[];
  handler?: ToolHandler;
  maxRetries?: number;
  retryDelay?: number;
  dangerous?: boolean;
  cacheable?: boolean;
  timeout?: number;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  result: string;
  error?: string;
  retries?: number;
  duration?: number;
}

const CACHE_MAXSIZE = 128;
const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * Two tool calls with identical arguments in a different key order must map to
 * the same cache/dedup key. Plain `JSON.stringify` is order-sensitive, and the
 * `JSON.stringify(obj, keys.sort())` replacer-array trick only sorts the top
 * level *and silently drops nested keys* — so we recurse explicitly.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: any): any {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, any> = {};
  for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
  return out;
}
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY = 0.5; // seconds

/**
 * Tool result cache
 */
class ToolResultStore {
  private store: Map<string, Map<string, string>> = new Map();

  get(toolName: string, key: string): string | undefined {
    const bucket = this.store.get(toolName);
    if (!bucket) return undefined;

    const value = bucket.get(key);
    if (value) {
      // Move to end (LRU)
      bucket.delete(key);
      bucket.set(key, value);
    }
    return value;
  }

  set(toolName: string, key: string, value: string): void {
    let bucket = this.store.get(toolName);
    if (!bucket) {
      bucket = new Map();
      this.store.set(toolName, bucket);
    }

    bucket.set(key, value);

    // Evict oldest if over limit
    if (bucket.size > CACHE_MAXSIZE) {
      const firstKey = bucket.keys().next().value;
      if (firstKey !== undefined) bucket.delete(firstKey);
    }
  }

  clear(toolName?: string): void {
    if (toolName) {
      this.store.delete(toolName);
    } else {
      this.store.clear();
    }
  }
}

const resultStore = new ToolResultStore();

/**
 * Type coercion for tool parameters
 */
function coerceValue(value: unknown, targetType: string): [boolean, unknown] {
  if (value === null || value === undefined) {
    return [true, value];
  }

  // Already correct type
  if (targetType === "string" && typeof value === "string") {
    return [true, value];
  }
  if (targetType === "number" && typeof value === "number") {
    return [true, value];
  }
  if (targetType === "boolean" && typeof value === "boolean") {
    return [true, value];
  }
  if (targetType === "array" && Array.isArray(value)) {
    return [true, value];
  }
  if (targetType === "object" && typeof value === "object") {
    return [true, value];
  }

  // Lenient coercion from string
  if (typeof value === "string") {
    const stripped = value.trim();

    if (targetType === "integer" || targetType === "number") {
      const num = parseInt(stripped, 10);
      if (!isNaN(num)) return [true, num];
      const float = parseFloat(stripped);
      if (!isNaN(float)) return [true, float];
      return [false, value];
    }

    if (targetType === "boolean") {
      const lower = stripped.toLowerCase();
      if (["true", "1", "yes", "y"].includes(lower)) return [true, true];
      if (["false", "0", "no", "n"].includes(lower)) return [true, false];
      return [false, value];
    }

    if (targetType === "array") {
      if (stripped.includes(",")) {
        return [true, stripped.split(",").map((s) => s.trim())];
      }
      return [true, [value]];
    }
  }

  return [false, value];
}

/**
 * Tool registry and executor
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, ToolDefinition> = new Map();
  private breakers: Map<string, CircuitBreaker> = new Map();
  /** Per-tool runtime stats for the /tools observability command. */
  private stats: Map<string, { calls: number; failures: number; totalMs: number; cacheHits: number }> = new Map();

  private bumpStats(name: string, opts: { ms?: number; failed?: boolean; cacheHit?: boolean }): void {
    const s = this.stats.get(name) || { calls: 0, failures: 0, totalMs: 0, cacheHits: 0 };
    if (opts.cacheHit) s.cacheHits += 1;
    else {
      s.calls += 1;
      if (opts.failed) s.failures += 1;
      s.totalMs += opts.ms ?? 0;
    }
    this.stats.set(name, s);
  }

  /** Runtime stats per tool (only tools that were actually called), busiest first. */
  getStats(): Array<{ name: string; calls: number; failures: number; avgMs: number; cacheHits: number; breaker: string }> {
    return [...this.stats.entries()]
      .map(([name, s]) => ({
        name,
        calls: s.calls,
        failures: s.failures,
        avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0,
        cacheHits: s.cacheHits,
        breaker: this.breakers.get(name)?.getState() ?? 'closed',
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  /**
   * Register a tool
   */
  register(def: ToolDefinition): void {
    if (!def.name || !def.description) {
      throw new Error("Tool must have name and description");
    }

    this.tools.set(def.name, def);

    // Create circuit breaker for the tool
    if (!this.breakers.has(def.name)) {
      this.breakers.set(
        def.name,
        new CircuitBreaker({
          name: `tool_${def.name}`,
          failureThreshold: 5,
          resetTimeout: 60000,
        })
      );
    }

    log.info("Tool registered", { tool: def.name });
    this.emit("registered", def.name);
  }

  /**
   * Unregister a tool
   */
  unregister(toolName: string): void {
    this.tools.delete(toolName);
    this.emit("unregistered", toolName);
    log.info("Tool unregistered", { tool: toolName });
  }

  /**
   * Get a tool definition
   */
  get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  /**
   * List all registered tools
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if tool is registered
   */
  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Validate tool parameters
   */
  validateParameters(toolName: string, params: Record<string, unknown>): [boolean, string] {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return [false, `Tool ${toolName} not found`];
    }

    if (!tool.parameters) {
      return [true, ""];
    }

    for (const param of tool.parameters) {
      if (param.required && !(param.name in params)) {
        return [false, `Missing required parameter: ${param.name}`];
      }

      if (param.name in params) {
        const [valid] = coerceValue(params[param.name], param.type);
        if (!valid) {
          return [false, `Invalid type for parameter ${param.name}: expected ${param.type}`];
        }
      }
    }

    return [true, ""];
  }

  /**
   * Execute a tool with retry support
   */
  async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        result: "",
        error: `Tool ${toolName} not found`,
      };
    }

    // Check circuit breaker
    const breaker = this.breakers.get(toolName);
    if (breaker && !breaker.canExecute()) {
      return {
        success: false,
        result: "",
        error: `Tool ${toolName} is temporarily unavailable (circuit breaker open)`,
      };
    }

    // Check cache
    if (tool.cacheable) {
      const cacheKey = stableStringify(params);
      const cached = resultStore.get(toolName, cacheKey);
      if (cached) {
        log.debug("Tool cache hit", { tool: toolName });
        this.bumpStats(toolName, { cacheHit: true });
        return {
          success: true,
          result: cached,
        };
      }
    }

    // Validate parameters
    const [valid, error] = this.validateParameters(toolName, params);
    if (!valid) {
      return {
        success: false,
        result: "",
        error,
      };
    }

    // Execute with retries
    const maxRetries = tool.maxRetries ?? DEFAULT_RETRIES;
    const retryDelay = (tool.retryDelay ?? DEFAULT_RETRY_DELAY) * 1000;
    const timeout = tool.timeout ?? DEFAULT_TIMEOUT;

    let lastError: Error | null = null;
    let retries = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
        }

        if (!tool.handler) {
          throw new Error(`No handler for tool ${toolName}`);
        }

        const startTime = Date.now();

        // Execute with timeout
        const promise = tool.handler(params);
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Tool execution timeout")), timeout)
        );

        const result = await Promise.race([promise, timeoutPromise]);

        const duration = Date.now() - startTime;

        // Cache result
        if (tool.cacheable) {
          const cacheKey = stableStringify(params);
          resultStore.set(toolName, cacheKey, result);
        }

        breaker?.recordSuccess();

        log.info("Tool executed successfully", {
          tool: toolName,
          duration,
          retries: attempt,
        });

        this.bumpStats(toolName, { ms: duration });
        return {
          success: true,
          result,
          duration,
          retries: attempt,
        };
      } catch (error) {
        lastError = error as Error;
        retries = attempt;

        if (attempt < maxRetries) {
          log.warn("Tool execution failed, retrying", {
            tool: toolName,
            attempt: attempt + 1,
            error: lastError.message,
          });
        }
      }
    }

    breaker?.recordFailure();
    this.bumpStats(toolName, { failed: true });

    log.error("Tool execution failed after retries", {
      tool: toolName,
      retries,
      error: lastError?.message,
    });

    return {
      success: false,
      result: "",
      error: lastError?.message || "Tool execution failed",
      retries,
    };
  }

  /**
   * Get all tools (alias for list, used by agent code)
   */
  getTools(): ToolDefinition[] {
    return this.list();
  }

  /**
   * List all registered tool names
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Merge tools from another registry into this one.
   */
  merge(other: ToolRegistry): void {
    for (const tool of other.list()) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Clear result cache for a tool or all tools
   */
  clearCache(toolName?: string): void {
    resultStore.clear(toolName);
    if (toolName) {
      log.info("Tool cache cleared", { tool: toolName });
    } else {
      log.info("All tool caches cleared");
    }
  }
}

/**
 * Global tool registry
 */
let globalRegistry: ToolRegistry | null = null;

/**
 * Get the global tool registry
 */
export function getToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = new ToolRegistry();
  }
  return globalRegistry;
}
