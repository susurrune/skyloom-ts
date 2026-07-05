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
export interface ToolExecutionContext {
  signal: AbortSignal;
  attempt: number;
}

export interface ToolExecuteOptions {
  signal?: AbortSignal;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<string>;

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
  /**
   * Pure read-only tool with no side effects: two identical calls in the same
   * round always return the same thing. Enables within-round dedup (the second
   * identical call is skipped and shares the first result), which avoids
   * duplicate file reads / network searches the model often emits in parallel.
   * Unlike `cacheable`, it does NOT cache across rounds (the world may change).
   */
  idempotent?: boolean;
  timeout?: number;
  /**
   * Optional output guard: inspect the handler's result and return an error
   * message if it's not valid (else null/undefined). A non-null return makes
   * the call fail — routed through the same retry + circuit-breaker path as a
   * thrown error — so a tool/plugin can reject malformed output instead of
   * passing garbage back to the model as "success".
   */
  validateOutput?: (result: string, params: Record<string, unknown>) => string | null | undefined;
}

/** Order-stable JSON key so {a,b} and {b,a} hash to the same cache/dedup key. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((acc: Record<string, unknown>, key) => { acc[key] = v[key]; return acc; }, {})
      : v,
  );
}

/** Cache/dedup keys are an optimization and must never break execution. */
export function safeStableStringify(value: unknown): string | undefined {
  try {
    return stableStringify(value);
  } catch {
    return undefined;
  }
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
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY = 0.5; // seconds
const MAX_RETRIES = 10;
const MAX_TIMEOUT = 10 * 60 * 1000;
const MAX_RETRY_DELAY = 60;

function boundedNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return fallback;
  const bounded = Math.min(max, value);
  return integer ? Math.floor(bounded) : bounded;
}

/**
 * Tool result cache
 */
class ToolResultStore {
  private store: Map<string, Map<string, string>> = new Map();

  get(toolName: string, key: string): string | undefined {
    const bucket = this.store.get(toolName);
    if (!bucket) return undefined;

    const value = bucket.get(key);
    if (value !== undefined) {
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
    return Number.isFinite(value) ? [true, value] : [false, value];
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

  // string target accepts scalars (number/boolean) by stringifying them —
  // the model sometimes sends 5 where a string id is expected.
  if (targetType === "string" && (typeof value === "number" || typeof value === "boolean")) {
    return [true, String(value)];
  }

  // Lenient coercion from string
  if (typeof value === "string") {
    const stripped = value.trim();

    if (targetType === "integer" || targetType === "number") {
      // Number() handles ints and floats uniformly; parseInt truncated floats
      // ("3.5" -> 3), silently corrupting numeric args.
      if (stripped === "") return [false, value];
      const num = Number(stripped);
      if (Number.isFinite(num)) return [true, targetType === "integer" ? Math.trunc(num) : num];
      return [false, value];
    }

    if (targetType === "boolean") {
      const lower = stripped.toLowerCase();
      if (["true", "1", "yes", "y"].includes(lower)) return [true, true];
      if (["false", "0", "no", "n"].includes(lower)) return [true, false];
      return [false, value];
    }

    if (targetType === "array") {
      // The model often sends a JSON-encoded array string for array params.
      if (stripped.startsWith("[")) {
        try { const parsed = JSON.parse(stripped); if (Array.isArray(parsed)) return [true, parsed]; } catch { /* fall through */ }
      }
      if (stripped.includes(",")) {
        return [true, stripped.split(",").map((s) => s.trim())];
      }
      return [true, [value]];
    }

    if (targetType === "object") {
      try {
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return [true, parsed];
      } catch { /* not JSON */ }
      return [false, value];
    }
  }

  return [false, value];
}

/** Describe a value's runtime type for an error message. */
function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Tool registry and executor
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, ToolDefinition> = new Map();
  private breakers: Map<string, CircuitBreaker> = new Map();
  private resultStore = new ToolResultStore();
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

    if (this.tools.has(def.name)) this.resultStore.clear(def.name);
    this.tools.set(def.name, def);

    // Create circuit breaker for the tool
    this.breakers.set(
      def.name,
      new CircuitBreaker({
        name: `tool_${def.name}`,
        failureThreshold: 5,
        resetTimeout: 60000,
      })
    );

    log.info("Tool registered", { tool: def.name });
    this.emit("registered", def.name);
  }

  /**
   * Unregister a tool
   */
  unregister(toolName: string): void {
    this.tools.delete(toolName);
    this.breakers.delete(toolName);
    this.resultStore.clear(toolName);
    this.stats.delete(toolName);
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
   * Validate tool inputs against the declared schema AND return coerced args:
   * required-field presence, per-param type coercion (string<->number/bool,
   * JSON-string -> array/object), and enum membership. Returning the coerced
   * params means the handler receives clean, typed values (the model often
   * sends "5" / "true" / a JSON string), and rejecting malformed input before
   * execution gives the model a precise, actionable error to retry against.
   */
  validateAndCoerce(
    toolName: string,
    params: Record<string, unknown>,
  ): { ok: boolean; error?: string; params?: Record<string, unknown> } {
    const tool = this.tools.get(toolName);
    if (!tool) return { ok: false, error: `Tool ${toolName} not found` };
    if (!tool.parameters || tool.parameters.length === 0) return { ok: true, params };

    const out: Record<string, unknown> = { ...params };
    for (const param of tool.parameters) {
      const has = param.name in params && params[param.name] !== null && params[param.name] !== undefined;
      let rawValue: unknown;
      if (!has) {
        if (param.required) {
          return { ok: false, error: `Missing required parameter '${param.name}' (expected ${param.type}).` };
        }
        if (param.default === undefined) continue;
        rawValue = param.default;
      } else {
        rawValue = params[param.name];
      }

      const [valid, coerced] = coerceValue(rawValue, param.type);
      if (!valid) {
        return {
          ok: false,
          error: `Invalid type for parameter '${param.name}': expected ${param.type}, got ${describeType(rawValue)}.`,
        };
      }

      if (param.enum && param.enum.length > 0 && !param.enum.includes(String(coerced))) {
        return {
          ok: false,
          error: `Invalid value for parameter '${param.name}': '${String(coerced)}' is not allowed. Valid values: ${param.enum.join(", ")}.`,
        };
      }

      out[param.name] = coerced;
    }

    return { ok: true, params: out };
  }

  /**
   * Validate tool parameters (legacy boolean/message form; delegates to
   * validateAndCoerce).
   */
  validateParameters(toolName: string, params: Record<string, unknown>): [boolean, string] {
    const r = this.validateAndCoerce(toolName, params);
    return [r.ok, r.error || ""];
  }

  /**
   * Execute a tool with retry support
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    options: ToolExecuteOptions = {},
  ): Promise<ToolResult> {
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

    // Validate + coerce inputs against the schema BEFORE cache/execute, so the
    // handler and the cache key both use clean, typed values.
    const validated = this.validateAndCoerce(toolName, params);
    if (!validated.ok) {
      return {
        success: false,
        result: "",
        error: validated.error,
      };
    }
    params = validated.params!;

    if (options.signal?.aborted) {
      return {
        success: false,
        result: "",
        error: "Tool execution cancelled",
      };
    }

    // Check cache
    const cacheKey = tool.cacheable ? safeStableStringify(params) : undefined;
    if (tool.cacheable) {
      const cached = cacheKey === undefined ? undefined : this.resultStore.get(toolName, cacheKey);
      if (cached !== undefined) {
        log.debug("Tool cache hit", { tool: toolName });
        this.bumpStats(toolName, { cacheHit: true });
        return {
          success: true,
          result: cached,
        };
      }
    }

    // Execute with retries
    const defaultRetries = tool.idempotent || tool.cacheable ? DEFAULT_RETRIES : 0;
    const maxRetries = boundedNumber(tool.maxRetries, defaultRetries, 0, MAX_RETRIES, true);
    const retryDelay = boundedNumber(tool.retryDelay, DEFAULT_RETRY_DELAY, 0, MAX_RETRY_DELAY) * 1000;
    const timeout = boundedNumber(tool.timeout, DEFAULT_TIMEOUT, 1, MAX_TIMEOUT, true);

    let lastError: Error | null = null;
    let retries = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await waitForDelay(retryDelay * attempt, options.signal);
        }

        if (!tool.handler) {
          throw new Error(`No handler for tool ${toolName}`);
        }

        const startTime = Date.now();

        // Execute with a timeout that we always clear. The previous
        // Promise.race left the timeout's setTimeout pending whenever the
        // handler won — a dangling 30s timer per tool call that kept the event
        // loop alive (delaying process exit) and accumulated under load.
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rejectGuard: ((error: Error) => void) | undefined;
        const guardPromise = new Promise<string>((_, reject) => {
          rejectGuard = reject;
          timer = setTimeout(() => {
            const error = new Error("Tool execution timeout");
            reject(error);
            controller.abort(error);
          }, timeout);
        });
        const cancelFromCaller = () => {
          const error = new Error("Tool execution cancelled");
          rejectGuard?.(error);
          controller.abort(options.signal?.reason ?? error);
        };
        options.signal?.addEventListener('abort', cancelFromCaller, { once: true });
        if (options.signal?.aborted) cancelFromCaller();
        let result: string;
        try {
          result = await Promise.race([
            tool.handler(params, { signal: controller.signal, attempt }),
            guardPromise,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener('abort', cancelFromCaller);
        }

        // Built-in tools use an explicit error prefix for expected failures
        // (missing files, blocked paths, invalid requests). Preserve the text
        // for the model, but do not report it as a successful tool event or
        // retry a deterministic failure.
        if (/^\s*(?:error:|\[blocked\])/i.test(result)) {
          const duration = Date.now() - startTime;
          breaker?.recordFailure();
          this.bumpStats(toolName, { ms: duration, failed: true });
          return {
            success: false,
            result: '',
            error: result.trim(),
            duration,
            retries: attempt,
          };
        }

        // Output guard: a non-null message means the result is invalid. Throw so
        // it flows through the same retry + breaker path as any other failure.
        if (tool.validateOutput) {
          const outErr = tool.validateOutput(result, params);
          if (outErr) throw new Error(`invalid tool output: ${outErr}`);
        }

        const duration = Date.now() - startTime;

        // Cache result
        if (tool.cacheable && cacheKey !== undefined) {
          this.resultStore.set(toolName, cacheKey, result);
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

        if (lastError.message === "Tool execution cancelled") break;

        if (attempt < maxRetries) {
          log.warn("Tool execution failed, retrying", {
            tool: toolName,
            attempt: attempt + 1,
            error: lastError.message,
          });
        }
      }
    }

    if (lastError?.message === "Tool execution cancelled") {
      log.debug("Tool execution cancelled", { tool: toolName });
      return {
        success: false,
        result: "",
        error: lastError.message,
        retries,
      };
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
      this.register(tool);
    }
  }

  /**
   * Clear result cache for a tool or all tools
   */
  clearCache(toolName?: string): void {
    this.resultStore.clear(toolName);
    if (toolName) {
      log.info("Tool cache cleared", { tool: toolName });
    } else {
      log.info("All tool caches cleared");
    }
  }
}

function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Tool execution cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new Error("Tool execution cancelled"));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
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
