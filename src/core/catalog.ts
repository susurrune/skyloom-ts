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
  deepseek: { id: "deepseek", name: "DeepSeek", envVar: "DEEPSEEK_API_KEY", order: 1 },
  openai: { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", order: 2 },
  anthropic: { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", order: 3 },
  google: { id: "google", name: "Google Gemini", envVar: "GEMINI_API_KEY", order: 4 },
  groq: { id: "groq", name: "Groq", envVar: "GROQ_API_KEY", order: 5 },
  openrouter: { id: "openrouter", name: "OpenRouter (多模型)", envVar: "OPENROUTER_API_KEY", order: 6 },
  mistral: { id: "mistral", name: "Mistral", envVar: "MISTRAL_API_KEY", order: 7 },
  xai: { id: "xai", name: "xAI (Grok)", envVar: "XAI_API_KEY", order: 8 },
  ollama: { id: "ollama", name: "Ollama 本地", order: 9 },
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
