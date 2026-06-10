/**
 * 模型配置管理 — unified default with optional per-agent overrides.
 *
 * Resolution order (already honored by LLMClient.getModel / getApiKey):
 *   model:   agents.<name>.model  →  default_model
 *   apiKey:  agents.<name>.api_key → env var → api_keys.<provider>
 *
 * This module provides the write path: mutate the *runtime* config object
 * (shared by reference across LLMClient and every agent, so changes apply to
 * the very next call — agents can hot-swap their own model mid-session) and
 * persist a narrow patch to ~/.skyloom/config.yaml (never the merged config,
 * so defaults don't leak into the user file).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { USER_CONFIG_DIR } from './config';
import { listProviders, modelsFor, validateModel } from './catalog';

export interface ModelDescription {
  model: string;
  /** 'agent' = per-agent override, 'unified' = default_model. */
  source: 'agent' | 'unified';
  provider: string | null;
  /** Where the API key would come from for this agent. */
  keySource: 'agent' | 'env' | 'global' | 'missing';
}

/** Find which provider a catalog model id belongs to. */
export function providerOfModel(modelId: string): string | null {
  if (modelId.includes('/')) return modelId.split('/')[0];
  for (const p of listProviders()) {
    if (modelsFor(p).some(m => m.id === modelId)) return p;
  }
  return null;
}

/** Read-mutate-write the raw user config file (narrow patch). */
function patchUserConfig(mutate: (cfg: any) => void, dir: string = USER_CONFIG_DIR): void {
  const file = path.join(dir, 'config.yaml');
  let cfg: any = {};
  if (fs.existsSync(file)) {
    try { cfg = yaml.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch { cfg = {}; }
  }
  mutate(cfg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, yaml.stringify(cfg), 'utf-8');
}

/** Apply the same mutation to the in-memory runtime config (hot effect). */
function ensureAgentSlot(runtimeConfig: any, agentName: string): any {
  if (!runtimeConfig.agents) runtimeConfig.agents = {};
  if (!runtimeConfig.agents[agentName]) runtimeConfig.agents[agentName] = {};
  return runtimeConfig.agents[agentName];
}

export interface SetModelResult {
  ok: boolean;
  suggestions: string[];
  provider: string | null;
}

/** Per-agent model override (独立配置). */
export function setAgentModel(
  runtimeConfig: any,
  agentName: string,
  modelId: string,
  dir?: string
): SetModelResult {
  const v = validateModel(modelId);
  if (!v.ok) return { ok: false, suggestions: v.suggestions, provider: null };
  const provider = providerOfModel(modelId);

  const slot = ensureAgentSlot(runtimeConfig, agentName);
  slot.model = modelId;
  if (provider) slot.provider = provider;

  patchUserConfig(cfg => {
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents[agentName]) cfg.agents[agentName] = {};
    cfg.agents[agentName].model = modelId;
    if (provider) cfg.agents[agentName].provider = provider;
  }, dir);
  return { ok: true, suggestions: [], provider };
}

/** Remove the per-agent override — the agent follows the unified default again. */
export function clearAgentModel(runtimeConfig: any, agentName: string, dir?: string): void {
  if (runtimeConfig.agents?.[agentName]) {
    delete runtimeConfig.agents[agentName].model;
    delete runtimeConfig.agents[agentName].provider;
  }
  patchUserConfig(cfg => {
    if (cfg.agents?.[agentName]) {
      delete cfg.agents[agentName].model;
      delete cfg.agents[agentName].provider;
      if (Object.keys(cfg.agents[agentName]).length === 0) delete cfg.agents[agentName];
    }
  }, dir);
}

/** 统一配置 — the default model every agent without an override uses. */
export function setUnifiedModel(runtimeConfig: any, modelId: string, dir?: string): SetModelResult {
  const v = validateModel(modelId);
  if (!v.ok) return { ok: false, suggestions: v.suggestions, provider: null };
  const provider = providerOfModel(modelId);

  runtimeConfig.default_model = modelId;
  if (provider) runtimeConfig.default_provider = provider;

  patchUserConfig(cfg => {
    cfg.default_model = modelId;
    if (provider) cfg.default_provider = provider;
  }, dir);
  return { ok: true, suggestions: [], provider };
}

/** Per-agent API key (独立 key；该 agent 的所有调用优先用它). */
export function setAgentApiKey(runtimeConfig: any, agentName: string, key: string, dir?: string): void {
  ensureAgentSlot(runtimeConfig, agentName).api_key = key;
  patchUserConfig(cfg => {
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents[agentName]) cfg.agents[agentName] = {};
    cfg.agents[agentName].api_key = key;
  }, dir);
}

export function clearAgentApiKey(runtimeConfig: any, agentName: string, dir?: string): void {
  if (runtimeConfig.agents?.[agentName]) delete runtimeConfig.agents[agentName].api_key;
  patchUserConfig(cfg => {
    if (cfg.agents?.[agentName]) delete cfg.agents[agentName].api_key;
  }, dir);
}

/** Describe how an agent's model & key resolve right now. */
export function describeAgentLLM(runtimeConfig: any, agentName: string, dir: string = USER_CONFIG_DIR): ModelDescription {
  const agentCfg = runtimeConfig.agents?.[agentName] || {};
  const model: string = agentCfg.model
    || runtimeConfig.default_model
    || runtimeConfig.llm?.default_model
    || 'gpt-4o';
  const source: 'agent' | 'unified' = agentCfg.model ? 'agent' : 'unified';
  const provider = providerOfModel(model);

  let keySource: ModelDescription['keySource'] = 'missing';
  if (agentCfg.api_key) keySource = 'agent';
  else if (provider && process.env[`${provider.toUpperCase()}_API_KEY`]) keySource = 'env';
  else {
    try {
      const file = path.join(dir, 'config.yaml');
      const cfg = fs.existsSync(file) ? yaml.parse(fs.readFileSync(file, 'utf-8')) || {} : {};
      if (provider && cfg.api_keys?.[provider]) keySource = 'global';
    } catch { /* missing */ }
  }
  return { model, source, provider, keySource };
}
