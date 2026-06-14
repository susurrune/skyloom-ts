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
      "together",
      "openrouter",
      "google",
      "vertex_ai",
      "xai",
      "perplexity",
      "fireworks",
      "reka",
      "nvidia",
      "sambanova",
      "qwen",
      "zhipu",
      "lingyiwanwu",
      "minimax",
      "moonshot",
      "baidu",
      "baichuan",
      "stepfun",
      "lmstudio",
      "vllm",
      "litellm",
    ]);
  }

/**
 * Get provider-to-env-var mapping.
 */
  function getProviderEnvMap(): Map<string, string> {
    const envMap = new Map([
      ["openai", "OPENAI_API_KEY"],
      ["anthropic", "ANTHROPIC_API_KEY"],
      ["google", "GEMINI_API_KEY"],
      ["deepseek", "DEEPSEEK_API_KEY"],
      ["xai", "XAI_API_KEY"],
      ["mistral", "MISTRAL_API_KEY"],
      ["groq", "GROQ_API_KEY"],
      ["cohere", "COHERE_API_KEY"],
      ["perplexity", "PERPLEXITY_API_KEY"],
      ["fireworks", "FIREWORKS_API_KEY"],
      ["together", "TOGETHER_API_KEY"],
      ["openrouter", "OPENROUTER_API_KEY"],
      ["reka", "REKA_API_KEY"],
      ["nvidia", "NVIDIA_API_KEY"],
      ["sambanova", "SAMBANOVA_API_KEY"],
      ["qwen", "QWEN_API_KEY"],
      ["zhipu", "ZHIPU_API_KEY"],
      ["lingyiwanwu", "LINGYIWANWU_API_KEY"],
      ["minimax", "MINIMAX_API_KEY"],
      ["moonshot", "MOONSHOT_API_KEY"],
      ["baidu", "BAIDU_API_KEY"],
      ["baichuan", "BAICHUAN_API_KEY"],
      ["stepfun", "STEPFUN_API_KEY"],
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
    // Honor the user's configured default (set by the /setup wizard). YAML uses
    // snake_case; the legacy camelCase read is kept as a last resort.
    const c: any = this.config;
    return c.default_model || c.llm?.default_model || c.llm?.defaultModel || "gpt-4o";
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
   * Complete with retry logic — real HTTP call to LLM API.
   */
  private async completeWithRetry(
    model: string,
    messages: Record<string, unknown>[],
    agentName?: string,
    tools?: string[],
    _stream: boolean = false,
    overrides?: Record<string, unknown>
  ): Promise<LLMResponse> {
    const temperature = (overrides?.temperature as number) ?? 0.7;
    const maxTokens = (overrides?.maxTokens as number) ?? 4096;
    const maxRetries = (this.config.llm as any)?.maxRetries ?? 2;
    const isAnthropic = model.includes("claude") || model.startsWith("anthropic/");

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));

        let content: string;
        let toolCalls: ToolCall[] = [];
        let usage: UsageStats = { promptTokens: 0, completionTokens: 0 };

        if (isAnthropic) {
          const r = await this.callAnthropic(model, messages, tools, temperature, maxTokens, agentName);
          content = r.content; toolCalls = r.toolCalls; usage = r.usage;
        } else {
          const r = await this.callOpenAI(model, messages, tools, temperature, maxTokens, agentName);
          content = r.content; toolCalls = r.toolCalls; usage = r.usage;
        }

        const name = agentName || "default";
        if (!this.usageStats.has(name)) this.usageStats.set(name, { prompt_tokens: 0, completion_tokens: 0, calls: 0, cost: 0 });
        const s = this.usageStats.get(name)!;
        s.prompt_tokens += usage.promptTokens; s.completion_tokens += usage.completionTokens; s.calls += 1;
        const cost = estimateCost(model, usage.promptTokens, usage.completionTokens);
        s.cost += cost; this.totalCost += cost;

        return { content, toolCalls, model, usage, cost, truncated: false };
      } catch (e: any) {
        lastError = e;
        if (attempt >= maxRetries) throw e;
      }
    }
    throw lastError || new Error("Unknown error");
  }

  private async callOpenAI(
    m: string, messages: Record<string, unknown>[], tools?: string[], temp?: number, maxTok?: number, agentName?: string
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: UsageStats }> {
    const apiKey = this.getApiKey(m, agentName);
    const baseUrl = this.getBaseUrl(m);
    const body: Record<string, unknown> = { model: m, messages, temperature: temp ?? 0.7, max_tokens: maxTok ?? 4096 };
    if (tools?.length) {
      const defs = tools.map(t => this._toolRegistry.get(t)).filter(Boolean) as any[];
      if (defs.length) body.tools = defs.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: this.paramsToSchema(t.parameters || []) } }));
    }
    const resp = await fetch(baseUrl + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body: JSON.stringify(body) });
    if (!resp.ok) { const e: any = new Error("API " + resp.status + ": " + ((await resp.text()).slice(0, 200))); e.status_code = resp.status; throw e; }
    const data: any = await resp.json();
    const msg = data.choices?.[0]?.message || {};
    return { content: msg.content || "", toolCalls: (msg.tool_calls || []).map((tc: any) => ({ id: tc.id, type: "function", function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" } })), usage: { promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0 } };
  }

  private async callAnthropic(
    m: string, messages: Record<string, unknown>[], tools?: string[], temp?: number, maxTok?: number, agentName?: string
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: UsageStats }> {
    const apiKey = this.getApiKey("anthropic", agentName);
    const body: Record<string, unknown> = { model: m, max_tokens: maxTok ?? 4096, messages: messages.filter(msg => msg.role !== "system"), temperature: temp ?? 0.7 };
    const sys = messages.find(msg => msg.role === "system"); if (sys) body.system = sys.content;
    if (tools?.length) {
      const defs = tools.map(t => this._toolRegistry.get(t)).filter(Boolean) as any[];
      if (defs.length) body.tools = defs.map(t => ({ name: t.name, description: t.description, input_schema: this.paramsToSchema(t.parameters || []) }));
    }
    const resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
    if (!resp.ok) { const e: any = new Error("API " + resp.status + ": " + ((await resp.text()).slice(0, 200))); e.status_code = resp.status; throw e; }
    const data: any = await resp.json(); let content = ""; const toolCalls: ToolCall[] = [];
    for (const b of data.content || []) { if (b.type === "text") content += b.text; if (b.type === "tool_use") toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }); }
    return { content, toolCalls, usage: { promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0 } };
  }

  private paramsToSchema(params: any[]): Record<string, any> {
    const props: Record<string, any> = {};
    for (const p of params) props[p.name] = { type: p.type === "integer" ? "integer" : p.type === "number" ? "number" : p.type === "boolean" ? "boolean" : "string", description: p.description };
    const required = params.filter(p => p.required).map(p => p.name);
    return { type: "object", properties: props, ...(required.length > 0 ? { required } : {}) };
  }

  private getApiKey(model: string, agentName?: string): string {
    // 0. Per-agent override (agents.<name>.api_key) beats everything
    if (agentName) {
      const agentKey = (this.config.agents as any)?.[agentName]?.api_key;
      if (agentKey) return String(agentKey);
    }

    let provider = "openai"; const [pr] = splitProvider(model); if (pr) provider = pr;
    else { const l = model.toLowerCase(); if (l.includes("claude")) provider = "anthropic"; else if (l.includes("deepseek")) provider = "deepseek"; else if (l.includes("groq")) provider = "groq"; else if (l.includes("openrouter")) provider = "openrouter"; else if (l.includes("gemini")) provider = "gemini"; }
    const envMap = getProviderEnvMap();
    const envVar = envMap.get(provider) || (provider.toUpperCase() + "_API_KEY");

    // 1. Check environment variable first
    let key = process.env[envVar];
    if (key) return key;

    // 2. Check config file (~/.skyloom/config.yaml)
    try {
      const fs = require("fs"); const path = require("path"); const yaml = require("yaml");
      const cfgPath = path.join(require("os").homedir(), ".skyloom", "config.yaml");
      if (fs.existsSync(cfgPath)) {
        const cfg = yaml.parse(fs.readFileSync(cfgPath, "utf-8")) || {};
        const keys = cfg.api_keys || {};
        if (keys[provider]) return keys[provider];
      }
    } catch { /* ignore */ }

    throw new Error("Missing " + envVar + ". Run: sky apikey set " + provider + " YOUR_KEY");
  }

  private getBaseUrl(model: string): string {
    let provider = "openai"; const [pr] = splitProvider(model); if (pr) provider = pr;
    else { const l = model.toLowerCase(); if (l.includes("claude")) return "https://api.anthropic.com/v1"; else if (l.includes("deepseek")) return "https://api.deepseek.com/v1"; else if (l.includes("groq")) return "https://api.groq.com/openai/v1"; else if (l.includes("openrouter")) return "https://openrouter.ai/api/v1"; else if (l.includes("ollama")) return ((process.env.OLLAMA_HOST || "http://localhost:11434") + "/v1"); }
    const urls: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      google: "https://generativelanguage.googleapis.com/v1beta",
      deepseek: "https://api.deepseek.com/v1",
      xai: "https://api.x.ai/v1",
      mistral: "https://api.mistral.ai/v1",
      groq: "https://api.groq.com/openai/v1",
      cohere: "https://api.cohere.ai/v1",
      perplexity: "https://api.perplexity.ai",
      fireworks: "https://api.fireworks.ai/inference/v1",
      together: "https://api.together.xyz/v1",
      openrouter: "https://openrouter.ai/api/v1",
      reka: "https://api.reka.ai/v1",
      nvidia: "https://integrate.api.nvidia.com/v1",
      sambanova: "https://api.sambanova.ai/v1",
      qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      zhipu: "https://open.bigmodel.cn/api/paas/v4",
      lingyiwanwu: "https://api.lingyiwanwu.com/v1",
      minimax: "https://api.minimax.chat/v1",
      moonshot: "https://api.moonshot.cn/v1",
      baidu: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop",
      baichuan: "https://api.baichuan-ai.com/v1",
      stepfun: "https://api.stepfun.com/v1",
      ollama: (process.env.OLLAMA_HOST || "http://localhost:11434") + "/v1",
      lmstudio: (process.env.LMSTUDIO_HOST || "http://localhost:1234") + "/v1",
      vllm: (process.env.VLLM_HOST || "http://localhost:8000") + "/v1",
      litellm: (process.env.LITELLM_HOST || "http://localhost:4000") + "/v1",
    };
    return urls[provider] || urls.openai;
  }

  async *stream(
    messages: Record<string, unknown>[], agentName?: string
  ): AsyncGenerator<string> {
    const response = await this.complete(messages, agentName);
    yield response.content;
  }

  /**
   * Real SSE token streaming for OpenAI-compatible providers (openai, deepseek,
   * groq, openrouter, mistral, xai, ollama). Content + reasoning deltas are
   * yielded as they arrive; tool-call deltas are accumulated by index and
   * emitted once complete. Usage comes from the final `stream_options` chunk.
   */
  private async *callOpenAIStream(
    m: string, messages: Record<string, unknown>[], tools?: string[], temp?: number, maxTok?: number, signal?: AbortSignal, agentName?: string
  ): AsyncGenerator<StreamEvent> {
    // Honor a per-agent API key override (agents.<name>.api_key) on the
    // streaming path too — previously only the non-streaming path passed it.
    const apiKey = this.getApiKey(m, agentName);
    const baseUrl = this.getBaseUrl(m);
    const body: Record<string, unknown> = {
      model: m, messages, temperature: temp ?? 0.7, max_tokens: maxTok ?? 4096,
      stream: true, stream_options: { include_usage: true },
    };
    if (tools?.length) {
      const defs = tools.map(t => this._toolRegistry.get(t)).filter(Boolean) as any[];
      if (defs.length) body.tools = defs.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: this.paramsToSchema(t.parameters || []) } }));
    }
    const resp = await fetch(baseUrl + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey }, body: JSON.stringify(body), signal });
    if (!resp.ok || !resp.body) { const e: any = new Error("API " + resp.status + ": " + ((await resp.text()).slice(0, 200))); e.status_code = resp.status; throw e; }

    const reader = (resp.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let usage: UsageStats = { promptTokens: 0, completionTokens: 0 };
    let reasoning = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: any; try { json = JSON.parse(data); } catch { continue; }
        if (json.usage) usage = { promptTokens: json.usage.prompt_tokens || 0, completionTokens: json.usage.completion_tokens || 0 };
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: "content", text: delta.content };
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; yield { type: "reasoning", text: delta.reasoning_content }; }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolAcc.get(idx) || { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(idx, acc);
          }
        }
      }
    }
    for (const acc of toolAcc.values()) {
      if (acc.name) yield { type: "tool_call", toolCall: { id: acc.id || ("call_" + acc.name), type: "function", function: { name: acc.name, arguments: acc.args || "{}" } } };
    }
    yield { type: "done", usage, reasoningContent: reasoning || undefined };
  }

  async *streamWithTools(
    messages: Record<string, unknown>[], agentName?: string, tools?: string[],
    _toolRegistry?: ToolRegistry, overrides?: Record<string, unknown>, signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    this.checkBudget();
    const ov = overrides || {};
    const model: string = typeof ov.model === "string" ? ov.model : this.getModel(agentName);
    const temperature = (ov.temperature as number) ?? 0.7;
    const maxTokens = (ov.maxTokens as number) ?? 4096;
    const isAnthropic = model.includes("claude") || model.startsWith("anthropic/");

    // Blocking fallback used for Anthropic (different wire format) and on
    // failures before any content has streamed (preserves fallback chain + retry).
    const blockingFallback = async function* (this: LLMClient): AsyncGenerator<StreamEvent> {
      const response = await this.complete(messages, agentName, tools, false, overrides);
      if (response.content) yield { type: "content", text: response.content };
      for (const tc of response.toolCalls || []) yield { type: "tool_call", toolCall: tc };
      yield { type: "done", usage: response.usage, reasoningContent: response.reasoningContent };
    }.bind(this);

    if (isAnthropic) { yield* blockingFallback(); return; }

    let started = false;
    let usage: UsageStats = { promptTokens: 0, completionTokens: 0 };
    try {
      for await (const ev of this.callOpenAIStream(model, messages, tools, temperature, maxTokens, signal, agentName)) {
        if (ev.type === "content" || ev.type === "tool_call") started = true;
        if (ev.type === "done" && ev.usage) usage = ev.usage;
        yield ev;
      }
    } catch (e: any) {
      // User interrupt (Ctrl-C): stop cleanly — keep whatever streamed, no error, no fallback.
      if (signal?.aborted || e?.name === "AbortError") { yield { type: "done", usage }; return; }
      if (started) { yield { type: "error", text: String(e?.message || e) }; yield { type: "done", usage }; return; }
      this.log?.warn("stream_failed_fallback", { model, error: String(e?.message || e) });
      yield* blockingFallback();
      return;
    }

    // Usage + cost bookkeeping (mirrors completeWithRetry).
    const name = agentName || "default";
    if (!this.usageStats.has(name)) this.usageStats.set(name, { prompt_tokens: 0, completion_tokens: 0, calls: 0, cost: 0 });
    const s = this.usageStats.get(name)!;
    s.prompt_tokens += usage.promptTokens; s.completion_tokens += usage.completionTokens; s.calls += 1;
    const cost = estimateCost(model, usage.promptTokens, usage.completionTokens);
    s.cost += cost; this.totalCost += cost;
  }
}
