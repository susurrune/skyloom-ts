import { describe, it, expect } from "vitest";
import { mergeConfigs } from "../src/core/config";

describe("mergeConfigs", () => {
  it("preserves top-level default_model / default_provider (regression)", () => {
    // Previously these were dropped, so the wizard's chosen model never applied.
    const def: any = { agents: { fog: { temperature: 0.7 } }, llm: { default_model: "gpt-4o" } };
    const user: any = { default_model: "deepseek-v4-flash", default_provider: "deepseek" };
    const merged: any = mergeConfigs(def, user);
    expect(merged.default_model).toBe("deepseek-v4-flash");
    expect(merged.default_provider).toBe("deepseek");
  });

  it("deep-merges the llm block with the user winning", () => {
    const def: any = { agents: {}, llm: { default_model: "gpt-4o", temperature: 0.7 } };
    const user: any = { llm: { default_model: "deepseek-chat" } };
    const merged: any = mergeConfigs(def, user);
    expect(merged.llm.default_model).toBe("deepseek-chat");
    expect(merged.llm.temperature).toBe(0.7); // preserved from default
  });

  it("merges agents (user overrides, defaults retained)", () => {
    const def: any = { agents: { fog: { temperature: 0.7 }, rain: { temperature: 0.5 } } };
    const user: any = { agents: { fog: { model: "deepseek-v4-pro", temperature: 0.2 } } };
    const merged: any = mergeConfigs(def, user);
    expect(merged.agents.fog.model).toBe("deepseek-v4-pro");
    expect(merged.agents.rain.temperature).toBe(0.5);
  });

  it("returns the default config unchanged when no user config", () => {
    const def: any = { agents: { fog: {} }, default_model: "gpt-4o" };
    expect(mergeConfigs(def, null)).toBe(def);
  });

  it("preserves passthrough top-level blocks (memory, workspace)", () => {
    const def: any = { agents: {}, memory: { short_term_limit: 100 }, workspace: { path: "auto" } };
    const merged: any = mergeConfigs(def, { agents: {} } as any);
    expect(merged.memory.short_term_limit).toBe(100);
    expect(merged.workspace.path).toBe("auto");
  });
});
