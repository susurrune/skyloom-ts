import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import {
  providerOfModel, setAgentModel, clearAgentModel, setUnifiedModel,
  setAgentApiKey, clearAgentApiKey, describeAgentLLM,
} from "../src/core/model_config";
import { createModelTools } from "../src/tools/model_tool";

let tmp: string;
let cfg: any;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skymodel-"));
  cfg = { agents: {}, default_model: "gpt-4o" };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

const userYaml = () => yaml.parse(fs.readFileSync(path.join(tmp, "config.yaml"), "utf-8"));

describe("模型配置 — 统一 + 独立覆盖", () => {
  it("providerOfModel resolves catalog models and prefixed ids", () => {
    expect(providerOfModel("deepseek-chat")).toBe("deepseek");
    expect(providerOfModel("anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(providerOfModel("no-such-model")).toBeNull();
  });

  it("setAgentModel mutates runtime config AND persists a narrow patch", () => {
    const r = setAgentModel(cfg, "fog", "deepseek-chat", tmp);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("deepseek");
    // 热生效：运行时对象即刻更新（LLMClient.getModel 走同一引用）
    expect(cfg.agents.fog.model).toBe("deepseek-chat");
    // 持久化：只写覆盖项，不把合并后的默认配置泄漏进用户文件
    const u = userYaml();
    expect(u.agents.fog.model).toBe("deepseek-chat");
    expect(u.default_model).toBeUndefined();
  });

  it("rejects models not in the catalog, with suggestions", () => {
    const r = setAgentModel(cfg, "fog", "gpt-99-ultra", tmp);
    expect(r.ok).toBe(false);
    expect(cfg.agents.fog?.model).toBeUndefined();
  });

  it("clearAgentModel falls back to the unified default", () => {
    setAgentModel(cfg, "fog", "deepseek-chat", tmp);
    clearAgentModel(cfg, "fog", tmp);
    expect(cfg.agents.fog?.model).toBeUndefined();
    expect(describeAgentLLM(cfg, "fog", tmp).model).toBe("gpt-4o");
    expect(userYaml().agents?.fog).toBeUndefined();
  });

  it("setUnifiedModel changes the default for every non-overridden agent", () => {
    setAgentModel(cfg, "rain", "deepseek-chat", tmp);
    const r = setUnifiedModel(cfg, "gpt-4o-mini", tmp);
    expect(r.ok).toBe(true);
    expect(describeAgentLLM(cfg, "fog", tmp).model).toBe("gpt-4o-mini");   // 跟随统一
    expect(describeAgentLLM(cfg, "rain", tmp).model).toBe("deepseek-chat"); // 保持独立
    expect(userYaml().default_model).toBe("gpt-4o-mini");
  });

  it("per-agent api key: set/clear + keySource resolution", () => {
    setAgentApiKey(cfg, "fog", "sk-fog-own", tmp);
    expect(cfg.agents.fog.api_key).toBe("sk-fog-own");
    expect(describeAgentLLM(cfg, "fog", tmp).keySource).toBe("agent");
    expect(userYaml().agents.fog.api_key).toBe("sk-fog-own");

    clearAgentApiKey(cfg, "fog", tmp);
    expect(describeAgentLLM(cfg, "fog", tmp).keySource).toBe("missing");

    process.env.OPENAI_API_KEY = "sk-env";
    expect(describeAgentLLM(cfg, "fog", tmp).keySource).toBe("env");
  });

  it("describeAgentLLM reports source agent vs unified", () => {
    expect(describeAgentLLM(cfg, "fog", tmp).source).toBe("unified");
    setAgentModel(cfg, "fog", "deepseek-chat", tmp);
    const d = describeAgentLLM(cfg, "fog", tmp);
    expect(d.source).toBe("agent");
    expect(d.provider).toBe("deepseek");
  });
});

describe("agent 自助换模型工具", () => {
  it("set_my_model rejects unknown ids without touching config", async () => {
    const tools = createModelTools("fog", cfg);
    const setModel = tools.find(t => t.name === "set_my_model")!;
    const out = await setModel.handler({ model: "gpt-99-ultra" });
    expect(String(out)).toContain("✗");
    expect(cfg.agents.fog?.model).toBeUndefined();
  });

  it("list_models reports current model and catalog entries", async () => {
    const tools = createModelTools("fog", cfg);
    const list = tools.find(t => t.name === "list_models")!;
    const out = String(await list.handler({}));
    expect(out).toContain("Current: gpt-4o");
    expect(out).toContain("deepseek-chat");
  });
});
