/**
 * LLM abstraction layer with LiteLLM-compatible routing, retry, fallback, cost tracking, and budget control.
 *
 * Provides unified interface for multiple LLM providers (OpenAI, Anthropic, DeepSeek, etc.)
 * with automatic fallback chains, prompt caching for Anthropic, and cost estimation.
 */

import type { Logger } from "./logger";
import { LLMCache } from "./cache";
import type { ToolRegistry } from "./tool";

/**
 * LLM response from completion.
 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usage: UsageStats;
  cost: number;
  reasoningContent?: string;
  // True when LLM loop ran out of iterations before producing a tool-call-free answer
  truncated: boolean;
}

/**
 * Tool call extracted from LLM response.
 */
export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Token usage statistics.
 */
export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Streaming event from LLM.
 */
export interface StreamEvent {
  type: "content" | "tool_call" | "done" | "error" | "reasoning";
  text?: string;
  toolCall?: ToolCall;
  usage?: UsageStats;
  reasoningContent?: string;
}

/**
 * Split model string into provider and model name (e.g., "anthropic/claude-3-opus" → ["anthropic", "claude-3-opus"]).
 */
function splitProvider(model: string): [string | null, string] {
  if (!model.includes("/")) {
    return [null, model];
  }
  const [head, ...rest] = model.split("/");
  const provider = head.toLowerCase();
  const knownProviders = getKnownProviders();
  if (knownProviders.has(provider)) {
    return [provider, rest.join("/")];
  }
  return [null, model];
}

/**
 * Get set of known provider ID prefixes.
 */
function getKnownProviders(): Set<string> {
  return new Set([
    "openai",
    "azure",
    "anthropic",
    "deepseek",
    "ollama",
    "groq",
    "mistral",
    "cohere",
    "together_ai",
    "openrouter",
    "gemini",
    "vertex_ai",
  ]);
}

/**
 * Get provider-to-env-var mapping.
 */
function getProviderEnvMap(): Map<string, string> {
  const envMap = new Map([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
    ["groq", "GROQ_API_KEY"],
    ["mistral", "MISTRAL_API_KEY"],
    ["cohere", "COHERE_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
  ]);
  return envMap;
}

/**
 * Check if model targets Anthropic's API.
 */
function isAnthropicModel(model: string): boolean {
  const lowered = model.toLowerCase();
  if (lowered.startsWith("anthropic/") || lowered.startsWith("claude")) {
    return true;
  }
  const [provider] = splitProvider(model);
  return provider === "anthropic";
}

/**
 * Check if model targets DeepSeek's API.
 */
function isDeepseekModel(model: string): boolean {
  const [provider, stripped] = splitProvider(model);
  const lowered = model.toLowerCase();
  return (
    provider === "deepseek" ||
    lowered.startsWith("deepseek") ||
    stripped.startsWith("deepseek")
  );
}

/**
 * Check if DeepSeek model supports tool calls.
 * Reasoning models are not reliable function-call models.
 */
function deepseekSupportsTools(model: string): boolean {
  const lowered = model.toLowerCase();
  return !["reasoner", "-r1", "/r1"].some((part) => lowered.includes(part));
}

/**
 * Filter models by tool compatibility.
 */
function toolCompatibleModels(
  primary: string,
  models: string[],
  needsTools: boolean
): string[] {
  if (!needsTools) {
    return models;
  }

  const compatible = models.filter(
    (m) => !isDeepseekModel(m) || deepseekSupportsTools(m)
  );

  if (compatible.length > 0) {
    return compatible;
  }

  if (isDeepseekModel(primary)) {
    return ["deepseek/deepseek-chat"];
  }

  return models;
}

/**
 * Apply Anthropic ephemeral cache markers to messages and tools.
 *
 * Anthropic charges full input tokens for repeated identical prefixes.
 * Adding `cache_control: {"type": "ephemeral"}` to system prompt and tools
 * enables 5-minute KV cache, reducing input cost ~80% on subsequent turns.
 */
function _applyAnthropicCacheControl(
  model: string,
  messages: Record<string, unknown>[],
  toolSchemas: Record<string, unknown>[] | null
): [Record<string, unknown>[], Record<string, unknown>[] | null] {
  if (!isAnthropicModel(model)) {
    return [messages, toolSchemas];
  }

  // Process messages to add cache_control to system message
  const newMessages: Record<string, unknown>[] = [];
  let cachedSystem = false;

  for (const msg of messages) {
    if (
      !cachedSystem &&
      msg.role === "system" &&
      typeof msg.content === "string"
    ) {
      const content = msg.content as string;
      if (content) {
        newMessages.push({
          role: "system",
          content: [
            {
              type: "text",
              text: content,
              cache_control: { type: "ephemeral" },
            },
          ],
        });
        cachedSystem = true;
        continue;
      }
    }

    if (
      !cachedSystem &&
      msg.role === "system" &&
      Array.isArray(msg.content)
    ) {
      const content = msg.content as Record<string, unknown>[];
      if (content.length > 0) {
        const newBlocks = content.map((block) => ({ ...block }));
        const lastBlock = newBlocks[newBlocks.length - 1];
        newBlocks[newBlocks.length - 1] = {
          ...lastBlock,
          cache_control: { type: "ephemeral" },
        };
        newMessages.push({
          ...msg,
          content: newBlocks,
        });
        cachedSystem = true;
        continue;
      }
    }

    newMessages.push(msg);
  }

  // Add cache_control to tool schemas
  let newTools: Record<string, unknown>[] | null = null;
  if (toolSchemas && toolSchemas.length > 0) {
    newTools = toolSchemas.map((t) => ({ ...t }));
    const lastTool = newTools[newTools.length - 1];
    newTools[newTools.length - 1] = {
      ...lastTool,
      cache_control: { type: "ephemeral" },
    };
  }

  return [newMessages, newTools];
}

/**
 * Estimate token count for mixed CJK/English text.
 * CJK characters ~2 tokens each, non-CJK ~4 chars per token.
 */
function _estimateTokens(text: string): number {
  // Count CJK characters (simplified check)
  const cjkRegex = /[\u4E00-\u9FFF\u3040-\u309F\uAC00-\uD7AF]/g;
  const cjkCount = (text.match(cjkRegex) || []).length;
  const otherCount = text.length - cjkCount;
  return Math.max(1, cjkCount * 2 + Math.floor(otherCount / 4));
}

/**
 * Cost per 1K tokens (input / output) — USD.
 */
const MODEL_COST_ESTIMATES: Map<string, [number, number]> = new Map([
  ["gpt-4o", [0.0025, 0.01]],
  ["gpt-4o-mini", [0.00015, 0.0006]],
  ["gpt-4.1", [0.002, 0.008]],
  ["gpt-4.1-mini", [0.0004, 0.0016]],
  ["gpt-4.1-nano", [0.0001, 0.0004]],
  ["o3", [0.01, 0.04]],
  ["o4-mini", [0.0011, 0.0044]],
  ["claude-sonnet-4-6", [0.003, 0.015]],
  ["claude-opus-4-7", [0.005, 0.025]],
  ["claude-haiku-4-5", [0.0008, 0.004]],
  ["deepseek-chat", [0.00027, 0.0011]],
  ["deepseek-reasoner", [0.00055, 0.00219]],
  ["deepseek-v4-flash", [0.00014, 0.00028]],
  ["deepseek-v4-pro", [0.00174, 0.00348]],
  ["deepseek/deepseek-chat", [0.00027, 0.0011]],
  ["deepseek/deepseek-reasoner", [0.00055, 0.00219]],
  ["deepseek/deepseek-v4-flash", [0.00014, 0.00028]],
  ["deepseek/deepseek-v4-pro", [0.00174, 0.00348]],
  ["gemini/gemini-2.5-flash", [0.0003, 0.0025]],
  ["gemini/gemini-2.5-pro", [0.00125, 0.01]],
  ["ollama/llama3", [0.0, 0.0]],
  ["ollama/qwen2.5", [0.0, 0.0]],
]);

/**
 * Fallback chains for model availability.
 */
const FALLBACK_CHAINS: Map<string, string[]> = new Map([
  ["gpt-4o", ["gpt-4o-mini"]],
  ["gpt-4o-mini", ["gpt-4o"]],
  ["gpt-4.1", ["gpt-4.1-mini", "gpt-4o-mini"]],
  ["gpt-4.1-mini", ["gpt-4o-mini"]],
  ["gpt-4.1-nano", ["gpt-4.1-mini"]],
  ["o3", ["o4-mini", "gpt-4.1"]],
  ["o4-mini", ["gpt-4.1-mini"]],
  ["claude-sonnet-4-6", ["claude-haiku-4-5", "gpt-4.1-mini"]],
  ["claude-opus-4-7", ["claude-sonnet-4-6", "gpt-4.1"]],
  ["claude-haiku-4-5", ["gpt-4.1-mini"]],
  ["deepseek-chat", ["deepseek/deepseek-chat", "gpt-4.1-mini"]],
  ["deepseek-reasoner", ["deepseek/deepseek-chat", "gpt-4.1-mini"]],
  ["deepseek-v4-flash", ["deepseek/deepseek-chat", "gpt-4.1-mini"]],
  ["deepseek-v4-pro", ["deepseek-v4-flash", "deepseek/deepseek-chat", "gpt-4.1-mini"]],
  ["deepseek/deepseek-chat", ["gpt-4.1-mini"]],
  ["deepseek/deepseek-reasoner", ["deepseek/deepseek-chat", "gpt-4.1-mini"]],
  ["deepseek/deepseek-v4-flash", ["deepseek/deepseek-chat", "gpt-4.1-mini"]],
  ["deepseek/deepseek-v4-pro", [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-chat",
    "gpt-4.1-mini",
  ]],
  ["gemini/gemini-2.5-flash", ["gemini/gemini-2.5-pro", "gpt-4.1-mini"]],
  ["gemini/gemini-2.5-pro", ["gpt-4.1"]],
]);

/**
 * HTTP status codes that are considered transient errors (worth retrying).
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Check if an exception is worth retrying.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const status =
      (err as any).status_code || (err as any).http_status || 0;
    if (status && RETRYABLE_STATUSES.has(status)) {
      return true;
    }

    if (err.name === "TimeoutError") {
      return true;
    }

    const errName = err.constructor.name.toLowerCase();
    return [
      "ratelimiterror",
      "apitimeouterror",
      "apiconnectionerror",
      "serviceunavailableerror",
      "internalservererror",
      "timeout",
    ].includes(errName);
  }

  return false;
}

/**
 * Estimate cost for LLM API call.
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const costs = MODEL_COST_ESTIMATES.get(model) || [0.001, 0.002];
  return (
    (promptTokens / 1000) * costs[0] + (completionTokens / 1000) * costs[1]
  );
}

/**
 * Format user-facing error message for LLM failures.
 */
function formatUserFacingError(model: string, err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lowered = text.toLowerCase();
  const [provider] = splitProvider(model);

  // Missing API key
  if (
    lowered.includes("api_key") ||
    lowered.includes("authentication") ||
    lowered.includes("unauthorized")
  ) {
    const envMap = getProviderEnvMap();
    const envVar = envMap.get(provider || "") || "the appropriate *_API_KEY";
    const configured = Array.from(envMap.entries())
      .filter(([, e]) => process.env[e])
      .map(([p]) => p)
      .join(", ");
    const hint = configured
      ? `已配置: ${configured}。`
      : "未配置任何 API key。";
    return (
      `❌  ${model} 调用失败：缺少或无效的 API key。\n` +
      `请确认 \`${envVar}\` 已设置，或运行 \`sky init\` 重新配置。${hint}`
    );
  }

  if (lowered.includes("rate limit") || text.includes("429")) {
    return `❌  ${model} 速率受限，请稍后重试。`;
  }

  if (lowered.includes("timeout")) {
    return `❌  ${model} 请求超时，请稍后重试或调高超时时间。`;
  }

  if (
    lowered.includes("model") &&
    (lowered.includes("not found") || lowered.includes("does not exist"))
  ) {
    return (
      `❌  ${model} 不是该 provider 的有效模型 ID。\n` +
      `请运行配置检查或 \`sky init\` 重新选择。`
    );
  }

  // Content filtering / safety
  if (
    [
      "content exists risk",
      "content_policy",
      "content_filter",
      "content_filtered",
      "safety",
      "blocked by safety",
      "responsibleaipolicyviolation",
      "policy_violation",
    ].some((kw) => lowered.includes(kw))
  ) {
    const short = text.split("\n")[0].slice(0, 200);
    return (
      `❌  ${model} 拒绝该请求 (内容审核)：${short}\n` +
      `原因：provider 的内容安全过滤判定此次提问/上下文敏感。\n` +
      `建议：\n` +
      `  - 换一个 provider（如 OpenAI / Anthropic）\n` +
      `  - 把敏感关键词改写得更通用后重发`
    );
  }

  // Bad request / malformed sequence
  if (
    [
      "bad request",
      "invalid_request",
      "tool_calls",
      "tool messages",
    ].some((kw) => lowered.includes(kw)) ||
    err instanceof Error && err.constructor.name.toLowerCase().includes("badrequest")
  ) {
    const short = text.split("\n")[0].slice(0, 200);
    return (
      `❌  ${model} 调用失败 (Bad Request)：${short}\n` +
      `会话消息序列可能损坏，请清理后重试。`
    );
  }

  const short = text.split("\n")[0].slice(0, 200) || (err instanceof Error ? err.name : "Unknown error");
  return `❌  ${model} 调用失败：${short}`;
}

/**
 * Unified LLM client with retry, fallback chains, caching, cost tracking, and budget control.
 */
export class LLMClient {
  private config: any;
  private _toolRegistry: ToolRegistry;
  private _cache: LLMCache;
  private usageStats: Map<string, Record<string, number>> = new Map();
  private totalCost: number = 0;
  private costLimit: number | null;
  private log: Logger | null = null;

  constructor(
    config: any,
    toolRegistry: ToolRegistry,
    costLimit: number | null = null
  ) {
    this.config = config;
    this._toolRegistry = toolRegistry;
    this._cache = new LLMCache(256, 120);
    this.costLimit = costLimit;
  }

  /**
   * Set logger instance for event tracking.
   */
  setLogger(log: Logger): void {
    this.log = log;
  }

  /**
   * Get model for a specific agent or default.
   */
  private getModel(agentName?: string): string {
    if (agentName) {
      const agentCfg = (this.config.agents as any)?.[agentName];
      if (agentCfg?.model) {
        return String(agentCfg.model);
      }
    }
    return this.config.llm?.defaultModel || "gpt-4o";
  }

  /**
   * Get max retries from config.
   */
  private _getRetries(): number {
    return (this.config.llm as any)?.maxRetries ?? 2;
  }

  /**
   * Track token usage and cost.
   */
  private trackUsage(
    agentName: string | undefined,
    model: string,
    promptTokens: number,
    completionTokens: number
  ): void {
    const key = agentName || "default";
    if (!this.usageStats.has(key)) {
      this.usageStats.set(key, {
        prompt_tokens: 0,
        completion_tokens: 0,
        calls: 0,
        cost: 0,
      });
    }

    const stats = this.usageStats.get(key)!;
    stats.prompt_tokens += promptTokens;
    stats.completion_tokens += completionTokens;
    stats.calls += 1;

    const cost = estimateCost(model, promptTokens, completionTokens);
    stats.cost += cost;
    this.totalCost += cost;
  }

  /**
   * Check if cost limit exceeded.
   */
  private checkBudget(): void {
    if (this.costLimit !== null && this.totalCost >= this.costLimit) {
      throw new Error(
        `Cost limit exceeded: $${this.totalCost.toFixed(4)} >= $${this.costLimit.toFixed(4)}`
      );
    }
  }

  /**
   * Check if API key is available for model.
   */
  private hasKeyForModel(model: string): boolean {
    let [provider] = splitProvider(model);

    if (!provider) {
      const lowered = model.toLowerCase();
      for (const p of getKnownProviders()) {
        if (lowered.includes(p)) {
          provider = p;
          break;
        }
      }
    }

    if (!provider) {
      return true; // Can't determine; don't skip
    }

    const envMap = getProviderEnvMap();
    const envVar =
      envMap.get(provider) || `${provider.toUpperCase()}_API_KEY`;
    return !!process.env[envVar];
  }

  /**
   * Get usage statistics.
   */
  getUsageStats(): Map<string, Record<string, number>> {
    return new Map(this.usageStats);
  }

  /**
   * Get total cost.
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Reset usage statistics and cost.
   */
  resetUsageStats(): void {
    this.usageStats.clear();
    this.totalCost = 0;
  }

  /**
   * Complete a prompt (dummy implementation).
   *
   * Note: Full implementation requires integrating with an actual LLM API provider.
   * This is a placeholder that shows the structure and interface.
   */
  async complete(
    messages: Record<string, unknown>[],
    agentName?: string,
    tools?: string[],
    stream: boolean = false,
    overrides?: Record<string, unknown>
  ): Promise<LLMResponse> {
    this.checkBudget();

    const ov = overrides || {};
    const rawModel = ov.model;
    const model: string =
      typeof rawModel === "string" ? rawModel : this.getModel(agentName);

    // Build fallback chain
    const fallbackModels =
      FALLBACK_CHAINS.get(model)?.filter((m) => this.hasKeyForModel(m)) || [];
    const modelsToTry = toolCompatibleModels(
      model,
      [model, ...fallbackModels],
      !!tools
    );

    // Try each model in sequence
    let lastError: Error | null = null;
    for (const attemptModel of modelsToTry) {
      try {
        this.checkBudget();
        return await this.completeWithRetry(
          attemptModel,
          messages,
          agentName,
          tools,
          stream,
          overrides
        );
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.log?.warn("llm_fallback", {
          model: attemptModel,
          agent: agentName,
          error: lastError.message,
        });
        continue;
      }
    }

    // All models failed
    return {
      content: formatUserFacingError(model, lastError),
      toolCalls: [],
      model,
      usage: { promptTokens: 0, completionTokens: 0 },
      cost: 0,
      truncated: false,
    };
  }

  /**
   * Complete with retry logic (placeholder).
   */
  private async completeWithRetry(
    model: string,
    _messages: Record<string, unknown>[],
    _agentName?: string,
    _tools?: string[],
    _stream: boolean = false,
    overrides?: Record<string, unknown>
  ): Promise<LLMResponse> {
    // This is a placeholder. Real implementation would:
    // 1. Validate cache
    // 2. Call actual LLM API (OpenAI, Anthropic, etc.)
    // 3. Apply Anthropic cache control if needed
    // 4. Handle retry logic with exponential backoff
    // 5. Track usage and cost
    // 6. Cache results if appropriate

    const _temperature = (overrides?.temperature as number) ?? 0.7;
    const _maxTokens = (overrides?.maxTokens as number) ?? 2000;

    // For now, return a dummy response
    return {
      content: "Placeholder response from LLM",
      toolCalls: [],
      model,
      usage: { promptTokens: 100, completionTokens: 50 },
      cost: estimateCost(model, 100, 50),
      truncated: false,
    };
  }

  /**
   * Stream a completion (placeholder).
   */
  async *stream(
    _messages: Record<string, unknown>[],
    _agentName?: string
  ): AsyncGenerator<string> {
    // Placeholder implementation
    yield "Streaming response...";
  }

  /**
   * Stream completion with tool awareness (placeholder).
   */
  async *streamWithTools(
    _messages: Record<string, unknown>[],
    _agentName?: string,
    _tools?: string[],
    _toolRegistry?: ToolRegistry,
    _overrides?: Record<string, unknown>
  ): AsyncGenerator<StreamEvent> {
    // Placeholder implementation
    yield {
      type: "content",
      text: "Tool-aware streaming response...",
    };
  }
}
