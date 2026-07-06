import { allModels, listProviders, modelsFor, PROVIDER_META, providerLabel, validateModel } from "../core/catalog";
import { loadProviderCatalog } from "../core/config";
import { patchUserConfig, providerOfModel } from "../core/model_config";
import { getSecurity, PERMISSION_MODE_ALIASES, type ApprovalMode } from "../core/security";
import { initWorkspace, resolveWorkspacePath } from "../core/workspace";

type AgentLike = {
  displayName?: string;
  planMode: boolean;
};

export interface WebSettingsContext {
  config: Record<string, any>;
  agentMap: Map<string, AgentLike>;
  workspacePath?: string;
}

export interface WebSettingsPatch {
  agent: string;
  unifiedModel?: string;
  workspacePath?: string;
  language?: "zh" | "en";
  approvalMode?: ApprovalMode;
  toolConcurrency?: number;
  toolResultLimit?: number;
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  planMode?: boolean;
  apiKey?: { provider: string; value: string };
  clearApiKey?: { provider: string };
  providerEndpoint?: { provider: string; baseUrl: string | null };
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
  "model", "temperature", "maxTokens", "planMode", "apiKey", "unifiedModel",
  "workspacePath", "clearApiKey", "providerEndpoint",
]);

function finiteNumber(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new WebSettingsError(`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return value;
}

function providerCredentialSource(config: Record<string, any>, provider: string): "environment" | "config" | "local" | "missing" {
  const meta = PROVIDER_META[provider];
  if (meta?.envVar && Boolean(process.env[meta.envVar])) return "environment";
  if (config.api_keys?.[provider]) return "config";
  const entries = modelsFor(provider);
  if (entries.length > 0 && entries.every((model) => model.local)) return "local";
  return "missing";
}

function providerConfigured(config: Record<string, any>, provider: string): boolean {
  return providerCredentialSource(config, provider) !== "missing";
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

function configuredBaseUrl(config: Record<string, any>, provider: string): string {
  return String(config.providers?.[provider]?.base_url || loadProviderCatalog()[provider]?.base_url || "");
}

function normalizeProvider(input: unknown, field: string): string {
  if (typeof input !== "string" || !listProviders().includes(input)) {
    throw new WebSettingsError(`${field} provider is invalid`);
  }
  return input;
}

function normalizeBaseUrl(input: unknown): string | null {
  if (input === null || input === "") return null;
  if (typeof input !== "string" || input.length > 2048) throw new WebSettingsError("provider endpoint is invalid");
  try {
    const url = new URL(input.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("unsafe endpoint");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new WebSettingsError("provider endpoint must be a credential-free HTTP(S) URL");
  }
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
    defaults: {
      model: resolvedModel(config, ""),
    },
    runtime: {
      language: llm.language === "en" ? "en" : "zh",
      approvalMode: resolvedApprovalMode(config),
      toolConcurrency: Number(llm.tool_concurrency) || 4,
      toolResultLimit: Number(llm.tool_result_limit) || 50000,
      workspacePath: context.workspacePath || resolveWorkspacePath(String(config.workspace?.path || "auto")),
    },
    agents,
    providers: listProviders().map((id) => {
      const credentialSource = providerCredentialSource(config, id);
      return {
        id,
        name: providerLabel(id),
        configured: credentialSource !== "missing",
        credentialSource,
        canClearKey: Boolean(config.api_keys?.[id]),
        local: modelsFor(id).every((model) => model.local),
        baseUrl: configuredBaseUrl(config, id),
      };
    }),
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
  if (raw.unifiedModel !== undefined) {
    if (typeof raw.unifiedModel !== "string" || !validateModel(raw.unifiedModel).ok) {
      throw new WebSettingsError("unifiedModel must be a known model id");
    }
    patch.unifiedModel = raw.unifiedModel;
  }
  if (raw.workspacePath !== undefined) {
    if (typeof raw.workspacePath !== "string" || !raw.workspacePath.trim() || raw.workspacePath.length > 1024 || raw.workspacePath.includes("\0")) {
      throw new WebSettingsError("workspacePath is invalid");
    }
    patch.workspacePath = raw.workspacePath.trim();
  }
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
  if (raw.clearApiKey !== undefined) {
    if (!raw.clearApiKey || typeof raw.clearApiKey !== "object" || Array.isArray(raw.clearApiKey)) {
      throw new WebSettingsError("clearApiKey is invalid");
    }
    patch.clearApiKey = { provider: normalizeProvider((raw.clearApiKey as Record<string, unknown>).provider, "clearApiKey") };
  }
  if (patch.apiKey && patch.clearApiKey) throw new WebSettingsError("apiKey and clearApiKey cannot be used together");
  if (raw.providerEndpoint !== undefined) {
    if (!raw.providerEndpoint || typeof raw.providerEndpoint !== "object" || Array.isArray(raw.providerEndpoint)) {
      throw new WebSettingsError("providerEndpoint is invalid");
    }
    const endpoint = raw.providerEndpoint as Record<string, unknown>;
    patch.providerEndpoint = {
      provider: normalizeProvider(endpoint.provider, "providerEndpoint"),
      baseUrl: normalizeBaseUrl(endpoint.baseUrl),
    };
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
  const workspacePath = patch.workspacePath === undefined
    ? undefined
    : initWorkspace(resolveWorkspacePath(patch.workspacePath));

  patchUserConfig((saved) => {
    if (patch.unifiedModel !== undefined) {
      saved.default_model = patch.unifiedModel;
      saved.default_provider = providerOfModel(patch.unifiedModel) || saved.default_provider;
    }
    if (patch.workspacePath !== undefined) {
      saved.workspace ||= {};
      saved.workspace.path = patch.workspacePath;
    }
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
    if (patch.clearApiKey && saved.api_keys) {
      delete saved.api_keys[patch.clearApiKey.provider];
      if (Object.keys(saved.api_keys).length === 0) delete saved.api_keys;
    }
    if (patch.providerEndpoint) {
      saved.providers ||= {};
      saved.providers[patch.providerEndpoint.provider] ||= {};
      if (patch.providerEndpoint.baseUrl === null) {
        delete saved.providers[patch.providerEndpoint.provider].base_url;
        if (Object.keys(saved.providers[patch.providerEndpoint.provider]).length === 0) {
          delete saved.providers[patch.providerEndpoint.provider];
        }
      } else {
        saved.providers[patch.providerEndpoint.provider].base_url = patch.providerEndpoint.baseUrl;
      }
    }
  }, options.configDir);

  const config = context.config;
  config.llm ||= {};
  config.cli ||= {};
  config.agents ||= {};
  config.agents[name] ||= {};
  const agentConfig = config.agents[name];
  if (patch.unifiedModel !== undefined) {
    config.default_model = patch.unifiedModel;
    config.default_provider = providerOfModel(patch.unifiedModel) || config.default_provider;
  }
  if (patch.workspacePath !== undefined) {
    config.workspace ||= {};
    config.workspace.path = patch.workspacePath;
    context.workspacePath = workspacePath;
  }
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
  if (patch.clearApiKey) {
    config.api_keys ||= {};
    delete config.api_keys[patch.clearApiKey.provider];
  }
  if (patch.providerEndpoint) {
    config.providers ||= {};
    config.providers[patch.providerEndpoint.provider] ||= {};
    if (patch.providerEndpoint.baseUrl === null) delete config.providers[patch.providerEndpoint.provider].base_url;
    else config.providers[patch.providerEndpoint.provider].base_url = patch.providerEndpoint.baseUrl;
  }
  return buildWebSettings(context);
}
