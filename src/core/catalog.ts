/**
 * Model & Provider Catalog — single source of truth.
 *
 * Replaces the three drifting copies of model data (config/models.yaml,
 * the hardcoded setup-wizard list in cli/main.ts, and the README table)
 * with one typed, validated catalog loaded from config/models.yaml.
 *
 * Every model exposed here is intended to be directly callable. Fictional
 * or unreleased models must not appear in models.yaml.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { CONFIG_DIR } from "./config";
import { getLogger } from "./logger";

const log = getLogger("catalog");

/** A single callable model. Costs are USD per 1M tokens. */
export interface ModelInfo {
  /** Model id as passed to the provider (e.g. "gpt-4o", "openai/gpt-4.1"). */
  id: string;
  /** Catalog provider key (e.g. "openai", "deepseek"). */
  provider: string;
  /** Context window in tokens. */
  context: number;
  /** Input cost, USD per 1M tokens. */
  costIn: number;
  /** Output cost, USD per 1M tokens. */
  costOut: number;
  /** Short human description. */
  desc: string;
  /** True for local/free providers (ollama, zero-cost). */
  local: boolean;
}

/** Display + ordering metadata for a provider in setup/UI. */
export interface ProviderMeta {
  id: string;
  /** Human label shown in the setup wizard. */
  name: string;
  /** Env var that supplies the API key (when applicable). */
  envVar?: string;
  /** Sort order in the wizard. */
  order: number;
}

/**
 * Provider display metadata. Ordering matches the setup wizard.
 * Provider *ids* match the keys used in config/models.yaml.
 */
export const PROVIDER_META: Record<string, ProviderMeta> = {
  // Major international providers
  openai: { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", order: 1 },
  anthropic: { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", order: 2 },
  google: { id: "google", name: "Google Gemini", envVar: "GEMINI_API_KEY", order: 3 },
  deepseek: { id: "deepseek", name: "DeepSeek", envVar: "DEEPSEEK_API_KEY", order: 4 },
  xai: { id: "xai", name: "xAI (Grok)", envVar: "XAI_API_KEY", order: 5 },
  mistral: { id: "mistral", name: "Mistral", envVar: "MISTRAL_API_KEY", order: 6 },
  groq: { id: "groq", name: "Groq", envVar: "GROQ_API_KEY", order: 7 },
  cohere: { id: "cohere", name: "Cohere", envVar: "COHERE_API_KEY", order: 8 },
  perplexity: { id: "perplexity", name: "Perplexity", envVar: "PERPLEXITY_API_KEY", order: 9 },
  fireworks: { id: "fireworks", name: "Fireworks AI", envVar: "FIREWORKS_API_KEY", order: 10 },
  together: { id: "together", name: "Together AI", envVar: "TOGETHER_API_KEY", order: 11 },
  openrouter: { id: "openrouter", name: "OpenRouter (多模型)", envVar: "OPENROUTER_API_KEY", order: 12 },
  reka: { id: "reka", name: "Reka", envVar: "REKA_API_KEY", order: 13 },
  nvidia: { id: "nvidia", name: "Nvidia NIM", envVar: "NVIDIA_API_KEY", order: 14 },
  sambanova: { id: "sambanova", name: "SambaNova", envVar: "SAMBANOVA_API_KEY", order: 15 },
  // Chinese providers
  qwen: { id: "qwen", name: "通义千问 (Qwen)", envVar: "QWEN_API_KEY", order: 20 },
  zhipu: { id: "zhipu", name: "智谱 AI (GLM)", envVar: "ZHIPU_API_KEY", order: 21 },
  lingyiwanwu: { id: "lingyiwanwu", name: "零一万物 (Yi)", envVar: "LINGYIWANWU_API_KEY", order: 22 },
  minimax: { id: "minimax", name: "MiniMax", envVar: "MINIMAX_API_KEY", order: 23 },
  moonshot: { id: "moonshot", name: "月之暗面 (Kimi)", envVar: "MOONSHOT_API_KEY", order: 24 },
  baidu: { id: "baidu", name: "百度 (文心一言)", envVar: "BAIDU_API_KEY", order: 25 },
  baichuan: { id: "baichuan", name: "百川智能", envVar: "BAICHUAN_API_KEY", order: 26 },
  stepfun: { id: "stepfun", name: "阶跃星辰", envVar: "STEPFUN_API_KEY", order: 27 },
  // Local / self-hosted
  ollama: { id: "ollama", name: "Ollama 本地", order: 30 },
  lmstudio: { id: "lmstudio", name: "LM Studio 本地", order: 31 },
  vllm: { id: "vllm", name: "vLLM 自托管", order: 32 },
  litellm: { id: "litellm", name: "LiteLLM 代理", order: 33 },
};

/** Raw shape of an entry in config/models.yaml. */
interface RawModelEntry {
  name: string;
  context?: number;
  cost_in?: number;
  cost_out?: number;
  desc?: string;
}

let catalogCache: Map<string, ModelInfo[]> | null = null;

function readModelsYaml(): Record<string, RawModelEntry[]> {
  const modelPath = path.join(CONFIG_DIR, "models.yaml");
  try {
    if (!fs.existsSync(modelPath)) {
      log.warn("models_yaml_missing", { path: modelPath });
      return {};
    }
    const data = yaml.parse(fs.readFileSync(modelPath, "utf-8"));
    return (data && typeof data === "object" ? data : {}) as Record<string, RawModelEntry[]>;
  } catch (e) {
    log.error("models_yaml_parse_failed", { error: String(e) });
    return {};
  }
}

/** Load (and cache) the full catalog as provider -> models. */
export function loadCatalog(): Map<string, ModelInfo[]> {
  if (catalogCache) return catalogCache;

  const raw = readModelsYaml();
  const catalog = new Map<string, ModelInfo[]>();

  for (const [provider, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    const models: ModelInfo[] = [];
    for (const e of entries) {
      if (!e || typeof e.name !== "string") continue;
      const costIn = e.cost_in ?? 0;
      const costOut = e.cost_out ?? 0;
      models.push({
        id: e.name,
        provider,
        context: e.context ?? 0,
        costIn,
        costOut,
        desc: e.desc ?? "",
        local: provider === "ollama" || (costIn === 0 && costOut === 0),
      });
    }
    if (models.length > 0) catalog.set(provider, models);
  }

  catalogCache = catalog;
  return catalog;
}

/** Clear the cache (used by tests). */
export function resetCatalogCache(): void {
  catalogCache = null;
}

/** All provider ids present in the catalog, in wizard order. */
export function listProviders(): string[] {
  const present = [...loadCatalog().keys()];
  return present.sort((a, b) => (PROVIDER_META[a]?.order ?? 99) - (PROVIDER_META[b]?.order ?? 99));
}

/** Models for a provider (empty array if unknown). */
export function modelsFor(provider: string): ModelInfo[] {
  return loadCatalog().get(provider) ?? [];
}

/** Flat list of every callable model across providers. */
export function allModels(): ModelInfo[] {
  return [...loadCatalog().values()].flat();
}

/**
 * Look up a model by id. Matching is tolerant of a "provider/" prefix
 * (e.g. "openai/gpt-4o" resolves to the "gpt-4o" entry under openai).
 */
export function getModelInfo(modelId: string): ModelInfo | null {
  const all = allModels();
  const exact = all.find((m) => m.id === modelId);
  if (exact) return exact;
  // tolerate provider/ prefix on either side
  const stripped = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  return all.find((m) => m.id === stripped || m.id.split("/").slice(1).join("/") === modelId) ?? null;
}

/** Whether a model id is a known, callable model in the catalog. */
export function isKnownModel(modelId: string): boolean {
  return getModelInfo(modelId) !== null;
}

/** Provider display label (falls back to the raw id). */
export function providerLabel(provider: string): string {
  return PROVIDER_META[provider]?.name ?? provider;
}

/**
 * Validate that a configured default model is callable. Returns a short
 * list of suggested model ids when it is not, so callers can fail loudly
 * instead of 404-ing at request time.
 */
export function validateModel(modelId: string | undefined): { ok: boolean; suggestions: string[] } {
  if (modelId && isKnownModel(modelId)) return { ok: true, suggestions: [] };
  const suggestions = allModels()
    .filter((m) => !m.local)
    .slice(0, 6)
    .map((m) => m.id);
  return { ok: false, suggestions };
}
