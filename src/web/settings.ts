import { allModels, listProviders, modelsFor, PROVIDER_META, providerLabel, validateModel } from "../core/catalog";
import { patchUserConfig, providerOfModel } from "../core/model_config";
import { getSecurity, PERMISSION_MODE_ALIASES, type ApprovalMode } from "../core/security";

type AgentLike = {
  displayName?: string;
  planMode: boolean;
};

export interface WebSettingsContext {
  config: Record<string, any>;
  agentMap: Map<string, AgentLike>;
}

export interface WebSettingsPatch {
  agent: string;
  language?: "zh" | "en";
  approvalMode?: ApprovalMode;
  toolConcurrency?: number;
  toolResultLimit?: number;
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  planMode?: boolean;
  apiKey?: { provider: string; value: string };
}

export interface WebSettingsOptions {
  configDir?: string;
}

export class WebSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSettingsError";
  }
}

const PATCH_FIELDS = new Set([
  "agent", "language", "approvalMode", "toolConcurrency", "toolResultLimit",
  "model", "temperature", "maxTokens", "planMode", "apiKey",
]);

function finiteNumber(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new WebSettingsError(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return value;
}

function providerConfigured(config: Record<string, any>, provider: string): boolean {
  const meta = PROVIDER_META[provider];
  if (meta?.envVar && Boolean(process.env[meta.envVar])) return true;
  if (config.api_keys?.[provider]) return true;
  const entries = modelsFor(provider);
  return entries.length > 0 && entries.every((model) => model.local);
}

function resolvedModel(config: Record<string, any>, agentName: string): string {
  return config.agents?.[agentName]?.model
    || config.default_model
    || config.llm?.default_model
    || config.llm?.defaultModel
    || "gpt-4o";
}

function resolvedApprovalMode(config: Record<string, any>): ApprovalMode {
  const raw = String(config.cli?.approval_mode || config.cli?.approvalMode || "interactive").toLowerCase();
  return PERMISSION_MODE_ALIASES[raw] || "interactive";
}

export function buildWebSettings(context: WebSettingsContext) {
  const config = context.config || {};
  const llm = config.llm || {};
  const agents = [...context.agentMap.entries()].map(([name, agent]) => {
    const agentConfig = config.agents?.[name] || {};
    const model = resolvedModel(config, name);
    const provider = providerOfModel(model);
    return {
      name,
      displayName: agent.displayName || name,
      model,
      modelSource: agentConfig.model ? "agent" : "unified",
      provider,
      temperature: Number(agentConfig.temperature ?? llm.temperature ?? 0.7),
      maxTokens: Number(agentConfig.max_tokens ?? llm.max_tokens ?? 4096),
      planMode: Boolean(agent.planMode),
      keyConfigured: Boolean(agentConfig.api_key) || (provider ? providerConfigured(config, provider) : false),
    };
  });

  return {
    runtime: {
      language: llm.language === "en" ? "en" : "zh",
      approvalMode: resolvedApprovalMode(config),
      toolConcurrency: Number(llm.tool_concurrency) || 4,
      toolResultLimit: Number(llm.tool_result_limit) || 50000,
    },
    agents,
    providers: listProviders().map((id) => ({
      id,
      name: providerLabel(id),
      configured: providerConfigured(config, id),
      local: modelsFor(id).every((model) => model.local),
    })),
    models: allModels().map((model) => ({
      id: model.id,
      provider: model.provider,
      context: model.context,
      local: model.local,
      description: model.desc,
    })),
  };
}

function normalizePatch(context: WebSettingsContext, input: unknown): WebSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WebSettingsError("settings patch must be an object");
  }
  const raw = input as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (!PATCH_FIELDS.has(field)) throw new WebSettingsError(`unknown settings field: ${field}`);
  }
  if (typeof raw.agent !== "string" || !context.agentMap.has(raw.agent)) {
    throw new WebSettingsError("agent must name an available agent");
  }

  const patch: WebSettingsPatch = { agent: raw.agent };
  if (raw.language !== undefined) {
    if (raw.language !== "zh" && raw.language !== "en") throw new WebSettingsError("language must be zh or en");
    patch.language = raw.language;
  }
  if (raw.approvalMode !== undefined) {
    if (typeof raw.approvalMode !== "string" || !PERMISSION_MODE_ALIASES[raw.approvalMode.toLowerCase()]) {
      throw new WebSettingsError("approvalMode is invalid");
    }
    patch.approvalMode = PERMISSION_MODE_ALIASES[raw.approvalMode.toLowerCase()];
  }
  if (raw.toolConcurrency !== undefined) patch.toolConcurrency = finiteNumber(raw.toolConcurrency, "toolConcurrency", 1, 16, true);
  if (raw.toolResultLimit !== undefined) patch.toolResultLimit = finiteNumber(raw.toolResultLimit, "toolResultLimit", 1000, 1000000, true);
  if (raw.model !== undefined) {
    if (raw.model !== null && typeof raw.model !== "string") throw new WebSettingsError("model must be a model id or null");
    if (typeof raw.model === "string" && !validateModel(raw.model).ok) throw new WebSettingsError(`unknown model: ${raw.model}`);
    patch.model = raw.model as string | null;
  }
  if (raw.temperature !== undefined) patch.temperature = finiteNumber(raw.temperature, "temperature", 0, 2);
  if (raw.maxTokens !== undefined) patch.maxTokens = finiteNumber(raw.maxTokens, "maxTokens", 256, 131072, true);
  if (raw.planMode !== undefined) {
    if (typeof raw.planMode !== "boolean") throw new WebSettingsError("planMode must be a boolean");
    patch.planMode = raw.planMode;
  }
  if (raw.apiKey !== undefined) {
    if (!raw.apiKey || typeof raw.apiKey !== "object" || Array.isArray(raw.apiKey)) throw new WebSettingsError("apiKey is invalid");
    const key = raw.apiKey as Record<string, unknown>;
    if (typeof key.provider !== "string" || !listProviders().includes(key.provider)) throw new WebSettingsError("apiKey provider is invalid");
    if (typeof key.value !== "string" || key.value.trim().length < 8 || key.value.length > 8192) throw new WebSettingsError("apiKey value is invalid");
    patch.apiKey = { provider: key.provider, value: key.value.trim() };
  }
  return patch;
}

export function applyWebSettings(
  context: WebSettingsContext,
  input: unknown,
  options: WebSettingsOptions = {},
) {
  const patch = normalizePatch(context, input);
  const name = patch.agent;

  patchUserConfig((saved) => {
    if (patch.language !== undefined || patch.toolConcurrency !== undefined || patch.toolResultLimit !== undefined) {
      saved.llm ||= {};
      if (patch.language !== undefined) saved.llm.language = patch.language;
      if (patch.toolConcurrency !== undefined) saved.llm.tool_concurrency = patch.toolConcurrency;
      if (patch.toolResultLimit !== undefined) saved.llm.tool_result_limit = patch.toolResultLimit;
    }
    if (patch.approvalMode !== undefined) {
      saved.cli ||= {};
      saved.cli.approval_mode = patch.approvalMode;
      delete saved.cli.approvalMode;
    }
    if (patch.model !== undefined || patch.temperature !== undefined || patch.maxTokens !== undefined || patch.planMode !== undefined) {
      saved.agents ||= {};
      saved.agents[name] ||= {};
      if (patch.model === null) {
        delete saved.agents[name].model;
        delete saved.agents[name].provider;
      } else if (patch.model !== undefined) {
        saved.agents[name].model = patch.model;
        const provider = providerOfModel(patch.model);
        if (provider) saved.agents[name].provider = provider;
      }
      if (patch.temperature !== undefined) saved.agents[name].temperature = patch.temperature;
      if (patch.maxTokens !== undefined) saved.agents[name].max_tokens = patch.maxTokens;
      if (patch.planMode !== undefined) saved.agents[name].plan_mode = patch.planMode;
    }
    if (patch.apiKey) {
      saved.api_keys ||= {};
      saved.api_keys[patch.apiKey.provider] = patch.apiKey.value;
    }
  }, options.configDir);

  const config = context.config;
  config.llm ||= {};
  config.cli ||= {};
  config.agents ||= {};
  config.agents[name] ||= {};
  const agentConfig = config.agents[name];
  if (patch.language !== undefined) config.llm.language = patch.language;
  if (patch.toolConcurrency !== undefined) config.llm.tool_concurrency = patch.toolConcurrency;
  if (patch.toolResultLimit !== undefined) config.llm.tool_result_limit = patch.toolResultLimit;
  if (patch.approvalMode !== undefined) {
    config.cli.approval_mode = patch.approvalMode;
    delete config.cli.approvalMode;
    getSecurity().setMode(patch.approvalMode);
  }
  if (patch.model === null) {
    delete agentConfig.model;
    delete agentConfig.provider;
  } else if (patch.model !== undefined) {
    agentConfig.model = patch.model;
    const provider = providerOfModel(patch.model);
    if (provider) agentConfig.provider = provider;
  }
  if (patch.temperature !== undefined) agentConfig.temperature = patch.temperature;
  if (patch.maxTokens !== undefined) agentConfig.max_tokens = patch.maxTokens;
  if (patch.planMode !== undefined) {
    agentConfig.plan_mode = patch.planMode;
    context.agentMap.get(name)!.planMode = patch.planMode;
  }
  if (patch.apiKey) {
    config.api_keys ||= {};
    config.api_keys[patch.apiKey.provider] = patch.apiKey.value;
  }
  return buildWebSettings(context);
}
