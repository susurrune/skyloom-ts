import { describe, it, expect, beforeEach } from "vitest";
import {
  loadCatalog,
  listProviders,
  modelsFor,
  allModels,
  getModelInfo,
  isKnownModel,
  providerLabel,
  validateModel,
  resetCatalogCache,
  PROVIDER_META,
} from "../src/core/catalog";

describe("catalog", () => {
  beforeEach(() => resetCatalogCache());

  it("loads providers from models.yaml", () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain("openai");
    expect(providers).toContain("deepseek");
  });

  it("orders providers by wizard order", () => {
    const providers = listProviders();
    const orders = providers.map((p) => PROVIDER_META[p]?.order ?? 99);
    const sorted = [...orders].sort((a, b) => a - b);
    expect(orders).toEqual(sorted);
  });

  it("parses real model fields (context + cost)", () => {
    const gpt4o = getModelInfo("gpt-4o");
    expect(gpt4o).not.toBeNull();
    expect(gpt4o!.provider).toBe("openai");
    expect(gpt4o!.context).toBeGreaterThan(0);
    expect(gpt4o!.costIn).toBeGreaterThan(0);
  });

  it("contains all real, API-verified deepseek models", () => {
    // Verified live against https://api.deepseek.com/v1/models
    expect(isKnownModel("deepseek-chat")).toBe(true);
    expect(isKnownModel("deepseek-reasoner")).toBe(true);
    expect(isKnownModel("deepseek-v4-flash")).toBe(true);
    expect(isKnownModel("deepseek-v4-pro")).toBe(true);
  });

  it("still rejects genuinely unknown model ids", () => {
    expect(isKnownModel("deepseek-v9-ultra")).toBe(false);
    expect(isKnownModel("gpt-5-imaginary")).toBe(false);
  });

  it("marks ollama / zero-cost models as local", () => {
    const local = allModels().filter((m) => m.local);
    expect(local.every((m) => m.costIn === 0 && m.costOut === 0)).toBe(true);
  });

  it("tolerates provider/ prefix when resolving", () => {
    // openrouter lists "openai/gpt-4.1"; bare "gpt-4.1" should also resolve
    const direct = getModelInfo("gpt-4.1");
    expect(direct).not.toBeNull();
  });

  it("validateModel passes for a real model and fails with suggestions otherwise", () => {
    expect(validateModel("gpt-4o").ok).toBe(true);
    const bad = validateModel("totally-made-up-model");
    expect(bad.ok).toBe(false);
    expect(bad.suggestions.length).toBeGreaterThan(0);
    expect(bad.suggestions.every((s) => isKnownModel(s))).toBe(true);
  });

  it("provides display labels", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("unknown-xyz")).toBe("unknown-xyz");
  });

  it("modelsFor returns empty for unknown provider", () => {
    expect(modelsFor("nope")).toEqual([]);
  });

  it("caches the catalog across calls", () => {
    const a = loadCatalog();
    const b = loadCatalog();
    expect(a).toBe(b);
  });
});
