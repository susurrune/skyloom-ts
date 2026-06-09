/**
 * Configuration management for Skyloom
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "yaml";
import { getLogger } from "./logger";

const log = getLogger("config");

/**
 * Configuration directory paths
 */
const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".weather-agents");

/**
 * Resolve the user configuration directory
 * Migrates from legacy ~/.weather-agents to ~/.skyloom if needed
 */
function resolveUserConfigDir(): string {
  const newDir = path.join(os.homedir(), ".skyloom");

  if (!fs.existsSync(newDir) && fs.existsSync(LEGACY_CONFIG_DIR)) {
    try {
      fs.renameSync(LEGACY_CONFIG_DIR, newDir);
      log.info("Migrated config directory", {
        from: LEGACY_CONFIG_DIR,
        to: newDir,
      });
    } catch (error) {
      log.warn("Failed to migrate config directory", {
        error: (error as Error).message,
      });
      return LEGACY_CONFIG_DIR;
    }
  }

  return newDir;
}

export const USER_CONFIG_DIR = resolveUserConfigDir();

/**
 * Find the config directory (bundled or user-provided)
 */
function findConfigDir(): string {
  // Locate the bundled `config/` across layouts. Compiled code lives at
  // <pkg>/dist/core/config.js, so the package's config/ is two levels up
  // (dist/core -> dist -> <pkg> ... -> <pkg>/config is "../../config").
  // Globally-installed packages have an arbitrary cwd, so cwd-relative paths
  // must NOT be the only option (the cause of the empty-catalog bug).
  const possiblePaths = [
    path.join(__dirname, "..", "..", "config"),       // <pkg>/dist/core -> <pkg>/config (installed + built)
    path.join(__dirname, "..", "..", "..", "config"), // legacy nested layout
    path.join(__dirname, "..", "config"),
    path.join(process.cwd(), "config"),               // running from a checkout
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(path.join(configPath, "default.yaml"))) {
      return configPath;
    }
  }

  // Fall back to user config directory
  return path.join(USER_CONFIG_DIR, "config");
}

export const CONFIG_DIR = findConfigDir();

/**
 * Memory configuration
 */
export interface MemoryConfig {
  dbPath: string;
  shortTermLimit: number;
  maxPersistedMessages?: number;
}

/**
 * All agent names — single source of truth
 */
export const AGENT_NAMES = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

/**
 * Load a YAML file safely
 */
function loadYaml(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const data = yaml.parse(content);

    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  } catch (error) {
    log.error("Failed to load YAML file", {
      file: filePath,
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Model catalog entry
 */
export interface ModelEntry {
  name: string;
  provider?: string;
  context_window?: number;
  max_output?: number;
  input_cost_per_1k?: number;
  output_cost_per_1k?: number;
  fallback?: string[];
}

/**
 * Load available models from models.yaml
 */
export function loadModelCatalog(): Record<string, ModelEntry[]> {
  const modelPath = path.join(CONFIG_DIR, "models.yaml");
  const data = loadYaml(modelPath);

  if (!data) {
    return {};
  }

  const catalog: Record<string, ModelEntry[]> = {};

  for (const [provider, models] of Object.entries(data)) {
    if (typeof models === "object" && models !== null) {
      catalog[provider] = [];

      for (const [name, info] of Object.entries(models as Record<string, unknown>)) {
        const entry: ModelEntry = { name };

        if (typeof info === "object" && info !== null) {
          Object.assign(entry, info);
        } else if (typeof info === "string") {
          entry.provider = info;
        }

        catalog[provider].push(entry);
      }
    }
  }

  return catalog;
}

/**
 * Provider catalog entry
 */
export interface ProviderEntry {
  env_var?: string;
  region?: string;
  docs_url?: string;
  base_url?: string;
  aliases?: string[];
  [key: string]: unknown;
}

let providerCatalogCache: Record<string, ProviderEntry> | null = null;

/**
 * Load provider catalog from providers.yaml
 */
export function loadProviderCatalog(): Record<string, ProviderEntry> {
  if (providerCatalogCache) {
    return providerCatalogCache;
  }

  const catalog: Record<string, ProviderEntry> = {};

  // Load bundled providers
  const bundledPath = path.join(CONFIG_DIR, "providers.yaml");
  const bundledData = loadYaml(bundledPath);

  if (bundledData) {
    for (const [key, value] of Object.entries(bundledData)) {
      if (typeof value === "object" && value !== null) {
        catalog[key] = { ...value } as ProviderEntry;
      }
    }
  }

  // Load user overrides
  const userPath = path.join(USER_CONFIG_DIR, "providers.yaml");
  const userData = loadYaml(userPath);

  if (userData) {
    for (const [key, value] of Object.entries(userData)) {
      if (typeof value === "object" && value !== null) {
        catalog[key] = {
          ...catalog[key],
          ...value,
        } as ProviderEntry;
      }
    }
  }

  providerCatalogCache = catalog;
  return catalog;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  model: string;
  provider: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  system_prompt?: string;
  tools?: string[];
}

/**
 * Skyloom configuration
 */
export interface SkyloomConfig {
  agents: Record<string, AgentConfig>;
  providers?: Record<string, ProviderEntry>;
  models?: Record<string, ModelEntry[]>;
  /** Top-level default model chosen by the setup wizard (e.g. "deepseek-v4-flash"). */
  default_model?: string;
  /** Top-level default provider chosen by the setup wizard. */
  default_provider?: string;
  /** LLM defaults block from default.yaml / user config (snake_case keys). */
  llm?: Record<string, any>;
  /** Other passthrough top-level config (memory, workspace, cli, mcp, plugins, tts…). */
  [key: string]: any;
}

/**
 * Load default configuration
 */
export function loadDefaultConfig(): SkyloomConfig {
  const defaultPath = path.join(CONFIG_DIR, "default.yaml");
  const data = loadYaml(defaultPath);

  if (!data) {
    return { agents: {} };
  }

  return data as unknown as SkyloomConfig;
}

/**
 * Load user configuration (from ~/.skyloom/config.yaml)
 */
export function loadUserConfig(): SkyloomConfig | null {
  const userPath = path.join(USER_CONFIG_DIR, "config.yaml");
  const data = loadYaml(userPath);

  if (!data) {
    return null;
  }

  return data as unknown as SkyloomConfig;
}

/**
 * Merge user config on top of default config
 */
export function mergeConfigs(defaultCfg: SkyloomConfig, userCfg: SkyloomConfig | null): SkyloomConfig {
  if (!userCfg) {
    return defaultCfg;
  }

  // Preserve all top-level keys (default_model, default_provider, llm, memory,
  // workspace, …) with the user winning, then deep-merge the known sub-objects.
  return {
    ...defaultCfg,
    ...userCfg,
    agents: {
      ...defaultCfg.agents,
      ...userCfg.agents,
    },
    providers: {
      ...(defaultCfg.providers || {}),
      ...(userCfg.providers || {}),
    },
    models: {
      ...(defaultCfg.models || {}),
      ...(userCfg.models || {}),
    },
    llm: {
      ...(defaultCfg.llm || {}),
      ...(userCfg.llm || {}),
    },
  };
}

/**
 * Load the complete configuration
 */
export function loadConfig(): SkyloomConfig {
  const defaultCfg = loadDefaultConfig();
  const userCfg = loadUserConfig();
  return mergeConfigs(defaultCfg, userCfg);
}

/**
 * Save user configuration
 */
export function saveUserConfig(config: SkyloomConfig): void {
  // Ensure user config directory exists
  if (!fs.existsSync(USER_CONFIG_DIR)) {
    fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  }

  const userPath = path.join(USER_CONFIG_DIR, "config.yaml");
  const content = yaml.stringify(config);

  fs.writeFileSync(userPath, content, "utf-8");
  log.info("Saved user configuration", { path: userPath });
}

/**
 * Get an agent configuration
 */
export function getAgentConfig(config: SkyloomConfig, agentName: string): AgentConfig | null {
  return config.agents[agentName] || null;
}

/**
 * Format models for display
 */
export function formatModelsForDisplay(catalog: Record<string, ModelEntry[]>): string {
  const lines: string[] = [];

  for (const [provider, models] of Object.entries(catalog)) {
    lines.push(`  [${provider.toUpperCase()}]`);

    for (const m of models) {
      const costParts: string[] = [];
      if (m.input_cost_per_1k) {
        costParts.push(`$${m.input_cost_per_1k.toFixed(4)}/1k in`);
      }
      if (m.output_cost_per_1k) {
        costParts.push(`$${m.output_cost_per_1k.toFixed(4)}/1k out`);
      }

      const costStr = costParts.length > 0 ? `  cost=(${costParts.join(", ")})` : "";
      const fallbackStr =
        m.fallback && m.fallback.length > 0 ? `  fallback->${m.fallback.join(" > ")}` : "";

      lines.push(
        `    ${m.name}  (ctx=${m.context_window || "?"}, max=${m.max_output || "?"})${costStr}${fallbackStr}`
      );
    }
  }

  return lines.join("\n");
}
