import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyWebSettings,
  buildWebSettings,
  WebSettingsError,
} from "../src/web/settings";
import { isLoopbackAddress } from "../src/web/server";

const tempDirs: string[] = [];

function tempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skyloom-web-settings-"));
  tempDirs.push(dir);
  return dir;
}

function fakeContext() {
  const fog = {
    name: "fog",
    displayName: "雾",
    planMode: false,
    state: "idle",
  };
  return {
    config: {
      default_model: "gpt-4o",
      api_keys: { openai: "sk-global-secret" },
      llm: {
        language: "zh",
        temperature: 0.7,
        max_tokens: 4096,
        tool_concurrency: 4,
        tool_result_limit: 50000,
      },
      cli: { approval_mode: "interactive" },
      agents: {
        fog: { temperature: 0.6, api_key: "sk-agent-secret" },
      },
    },
    agentMap: new Map([["fog", fog]]),
  } as any;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("web settings", () => {
  it("only permits settings writes from loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.42.0.9")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1%1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.20")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("returns useful settings without ever serializing API keys", () => {
    const snapshot = buildWebSettings(fakeContext());
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.runtime).toMatchObject({
      language: "zh",
      approvalMode: "interactive",
      toolConcurrency: 4,
      toolResultLimit: 50000,
    });
    expect(snapshot.agents[0]).toMatchObject({
      name: "fog",
      model: "gpt-4o",
      modelSource: "unified",
      temperature: 0.6,
      maxTokens: 4096,
      planMode: false,
      keyConfigured: true,
    });
    expect(snapshot.providers.find((provider) => provider.id === "openai")?.configured).toBe(true);
    expect(serialized).not.toContain("sk-global-secret");
    expect(serialized).not.toContain("sk-agent-secret");
    expect(serialized).not.toContain("api_keys");
    expect(serialized).not.toContain("api_key");
  });

  it("validates the full patch before applying and persists only allowlisted fields", () => {
    const context = fakeContext();
    const dir = tempConfigDir();
    const before = JSON.stringify(context.config);

    expect(() => applyWebSettings(context, {
      agent: "fog",
      language: "jp" as any,
      toolConcurrency: 99,
    }, { configDir: dir })).toThrow(WebSettingsError);
    expect(JSON.stringify(context.config)).toBe(before);
    expect(fs.existsSync(path.join(dir, "config.yaml"))).toBe(false);

    const snapshot = applyWebSettings(context, {
      agent: "fog",
      language: "en",
      approvalMode: "strict",
      toolConcurrency: 3,
      toolResultLimit: 24000,
      model: "gpt-4o-mini",
      temperature: 0.25,
      maxTokens: 2048,
      planMode: true,
      apiKey: { provider: "openai", value: "sk-new-secret-value" },
    }, { configDir: dir });

    expect(context.config.llm).toMatchObject({
      language: "en",
      tool_concurrency: 3,
      tool_result_limit: 24000,
    });
    expect(context.config.cli.approval_mode).toBe("strict");
    expect(context.config.agents.fog).toMatchObject({
      model: "gpt-4o-mini",
      temperature: 0.25,
      max_tokens: 2048,
      plan_mode: true,
    });
    expect(context.agentMap.get("fog")?.planMode).toBe(true);
    expect(snapshot.agents[0].keyConfigured).toBe(true);

    const saved = yaml.parse(fs.readFileSync(path.join(dir, "config.yaml"), "utf8"));
    expect(saved).toMatchObject({
      llm: {
        language: "en",
        tool_concurrency: 3,
        tool_result_limit: 24000,
      },
      cli: { approval_mode: "strict" },
      agents: {
        fog: {
          model: "gpt-4o-mini",
          temperature: 0.25,
          max_tokens: 2048,
          plan_mode: true,
        },
      },
      api_keys: { openai: "sk-new-secret-value" },
    });
    expect(saved.workspace).toBeUndefined();
  });

  it("rejects unknown fields, agents, providers, and invalid numeric ranges", () => {
    const context = fakeContext();
    const cases = [
      { agent: "fog", mystery: true },
      { agent: "storm", planMode: true },
      { agent: "fog", temperature: 3 },
      { agent: "fog", maxTokens: 100 },
      { agent: "fog", apiKey: { provider: "unknown", value: "secret-value" } },
    ];

    for (const patch of cases) {
      expect(() => applyWebSettings(context, patch as any, { configDir: tempConfigDir() }))
        .toThrow(WebSettingsError);
    }
  });
});
