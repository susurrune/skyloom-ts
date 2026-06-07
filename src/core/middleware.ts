/**
 * Middleware/interceptor chain for tool execution.
 *
 * Provides ACL (access control), rate limiting, and audit logging
 * as composable hooks around Tool.execute().
 */

import { Event, EventType, MessageBus } from './bus';
import { getLogger } from './logger';

const logger = getLogger('middleware');

/**
 * Middleware protocol/interface for tool execution hooks.
 */
export interface Middleware {
  /**
   * Called before tool execution.
   * @returns [allowed, reason] tuple
   */
  pre(toolName: string, agentName: string | null, kwargs: Record<string, any>): Promise<[boolean, string | null]>;

  /**
   * Called after tool execution (success or failure).
   */
  post(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, any>,
    result: string,
    success: boolean,
    durationMs: number
  ): Promise<void>;
}

/**
 * ACL rule for per-agent tool access control.
 */
interface ACLRule {
  allowedTools: Set<string>;
  deniedTools: Set<string>;
}

/**
 * Access-control list middleware.
 *
 * Controls which agents can call which tools. When `allowByDefault` is
 * True (default), only explicitly denied tools are blocked; when False,
 * only explicitly allowed tools are permitted.
 */
export class ACLMiddleware implements Middleware {
  private allowByDefault: boolean;
  private rules: Map<string, ACLRule> = new Map();

  constructor(allowByDefault: boolean = true) {
    this.allowByDefault = allowByDefault;
  }

  /**
   * Explicitly allow an agent to call specific tools.
   */
  allow(agentName: string, ...toolNames: string[]): void {
    let rule = this.rules.get(agentName);
    if (!rule) {
      rule = { allowedTools: new Set(), deniedTools: new Set() };
      this.rules.set(agentName, rule);
    }
    for (const t of toolNames) {
      rule.allowedTools.add(t);
      rule.deniedTools.delete(t);
    }
  }

  /**
   * Explicitly deny an agent from calling specific tools.
   */
  deny(agentName: string, ...toolNames: string[]): void {
    let rule = this.rules.get(agentName);
    if (!rule) {
      rule = { allowedTools: new Set(), deniedTools: new Set() };
      this.rules.set(agentName, rule);
    }
    for (const t of toolNames) {
      rule.deniedTools.add(t);
      rule.allowedTools.delete(t);
    }
  }

  /**
   * Remove all ACL rules for an agent.
   */
  removeRules(agentName: string): void {
    this.rules.delete(agentName);
  }

  async pre(
    toolName: string,
    agentName: string | null,
    _kwargs: Record<string, any>
  ): Promise<[boolean, string | null]> {
    if (agentName === null) {
      return this.allowByDefault ? [true, null] : [false, 'agent_name is required'];
    }

    const rule = this.rules.get(agentName);
    if (!rule) {
      return this.allowByDefault ? [true, null] : [false, `agent '${agentName}' has no ACL rules`];
    }

    if (rule.deniedTools.has(toolName)) {
      return [false, `agent '${agentName}' is not allowed to call '${toolName}'`];
    }

    if (!this.allowByDefault && !rule.allowedTools.has(toolName)) {
      return [false, `agent '${agentName}' is not allowed to call '${toolName}'`];
    }

    return [true, null];
  }

  async post(
    _toolName: string,
    _agentName: string | null,
    _kwargs: Record<string, any>,
    _result: string,
    _success: boolean,
    _durationMs: number
  ): Promise<void> {
    // No-op
  }
}

/**
 * Sliding-window rate limiter per tool.
 *
 * Limits the number of calls to each tool within a rolling time window.
 * Per-tool overrides can be set via `setLimit()`.
 */
export class RateLimitMiddleware implements Middleware {
  private defaultMaxCalls: number;
  private defaultWindow: number;
  private calls: Map<string, number[]> = new Map();
  private overrides: Map<string, [number, number]> = new Map();

  constructor(maxCalls: number = 30, windowSeconds: number = 60.0) {
    this.defaultMaxCalls = maxCalls;
    this.defaultWindow = windowSeconds;
  }

  /**
   * Set a per-tool rate limit override.
   */
  setLimit(toolName: string, maxCalls: number, windowSeconds: number): void {
    this.overrides.set(toolName, [maxCalls, windowSeconds]);
  }

  /**
   * Clear all recorded calls and overrides.
   */
  clear(): void {
    this.calls.clear();
    this.overrides.clear();
  }

  async pre(
    toolName: string,
    _agentName: string | null,
    _kwargs: Record<string, any>
  ): Promise<[boolean, string | null]> {
    const [maxCalls, window] = this.overrides.get(toolName) || [
      this.defaultMaxCalls,
      this.defaultWindow,
    ];

    const now = performance.now() / 1000; // Convert to seconds
    const cutoff = now - window;

    let calls = this.calls.get(toolName) || [];
    calls = calls.filter(t => t > cutoff);

    if (calls.length > 0) {
      this.calls.set(toolName, calls);
    } else {
      this.calls.delete(toolName);
    }

    if (calls.length >= maxCalls) {
      const remaining = Math.ceil(calls[0] + window - now);
      return [
        false,
        `rate limit exceeded for '${toolName}': ${maxCalls} calls per ${window}s window (retry in ~${remaining}s)`,
      ];
    }

    calls.push(now);
    this.calls.set(toolName, calls);
    return [true, null];
  }

  async post(
    _toolName: string,
    _agentName: string | null,
    _kwargs: Record<string, any>,
    _result: string,
    _success: boolean,
    _durationMs: number
  ): Promise<void> {
    // No-op
  }
}

/**
 * Audit-logging middleware.
 *
 * Publishes tool-call events to the message bus with timing,
 * agent identity, success/failure, and truncated result preview.
 */
export class AuditMiddleware implements Middleware {
  private bus: MessageBus | null;

  constructor(bus?: MessageBus | null) {
    this.bus = bus || null;
  }

  async pre(
    _toolName: string,
    _agentName: string | null,
    _kwargs: Record<string, any>
  ): Promise<[boolean, string | null]> {
    return [true, null];
  }

  async post(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, any>,
    result: string,
    success: boolean,
    durationMs: number
  ): Promise<void> {
    if (!this.bus) {
      return;
    }

    // Truncate args and result for safety
    const safeArgs: Record<string, any> = {};
    for (const [k, v] of Object.entries(kwargs)) {
      if (typeof v === 'string') {
        safeArgs[k] = v.slice(0, 200);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        safeArgs[k] = v;
      } else {
        safeArgs[k] = String(v).slice(0, 200);
      }
    }

    const safeResult = (result || '').slice(0, 500);

    try {
      this.bus.addEvent(
        new Event(EventType.TOOL_CALL, agentName || 'unknown', null, {
          tool: toolName,
          args: safeArgs,
          success,
          duration_ms: Math.round(durationMs * 10) / 10,
          result_preview: safeResult,
        })
      );
    } catch (err) {
      logger.warn('audit_log_failed', { tool: toolName, error: String(err) });
    }
  }
}

/**
 * Chain of middleware hooks applied around tool execution.
 *
 * Pre-hooks run in registration order; if any returns `[False, reason]`
 * the chain short-circuits and the tool is denied.
 * Post-hooks always run on success *or* failure.
 */
export class MiddlewareChain {
  private middlewares: Middleware[] = [];

  /**
   * Register a middleware instance.
   * Pre-hooks run in add() order.
   */
  add(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  /**
   * Run all pre-hooks in order.
   */
  async runPre(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, any>
  ): Promise<[boolean, string | null]> {
    for (const mw of this.middlewares) {
      const [allowed, reason] = await mw.pre(toolName, agentName, kwargs);
      if (!allowed) {
        return [false, reason];
      }
    }
    return [true, null];
  }

  /**
   * Run all post-hooks.
   */
  async runPost(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, any>,
    result: string,
    success: boolean,
    durationMs: number
  ): Promise<void> {
    for (const mw of this.middlewares) {
      try {
        await mw.post(toolName, agentName, kwargs, result, success, durationMs);
      } catch (err) {
        logger.warn('middleware_post_failed', {
          middleware: mw.constructor.name,
          tool: toolName,
          error: String(err),
        });
      }
    }
  }
}

// Global middleware chain
let globalChain: MiddlewareChain | null = null;

/**
 * Set the global middleware chain used by Tool.execute().
 */
export function setMiddlewareChain(chain: MiddlewareChain | null): void {
  globalChain = chain;
}

/**
 * Get the global middleware chain, or null.
 */
export function getMiddlewareChain(): MiddlewareChain | null {
  return globalChain;
}
