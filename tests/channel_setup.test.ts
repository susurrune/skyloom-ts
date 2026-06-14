import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CHANNEL_SETUP,
  SETUP_CHANNEL_IDS,
  callbackUrl,
  saveChannelConfig,
  missingRequired,
} from "../src/gateway/setup";
import { renderQR } from "../src/gateway/qr";

describe("channel setup · metadata", () => {
  it("covers the three channels with console URLs and webhook paths", () => {
    expect(SETUP_CHANNEL_IDS.sort()).toEqual(["feishu", "qq", "wecom"]);
    for (const id of SETUP_CHANNEL_IDS) {
      const s = CHANNEL_SETUP[id];
      expect(s.consoleUrl).toMatch(/^https:\/\//);
      expect(s.webhookPath).toBe(`/webhook/${id}`);
      expect(s.fields.length).toBeGreaterThan(0);
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });

  it("each channel marks its credential fields with env fallbacks", () => {
    const feishu = CHANNEL_SETUP.feishu;
    const appId = feishu.fields.find((f) => f.key === "appId")!;
    expect(appId.required).toBe(true);
    expect(appId.env).toBe("FEISHU_APP_ID");
    const secret = feishu.fields.find((f) => f.key === "appSecret")!;
    expect(secret.secret).toBe(true);
  });
});

describe("channel setup · callbackUrl", () => {
  it("joins base + webhook path, trimming trailing slash", () => {
    expect(callbackUrl("https://bot.example.com", "feishu")).toBe("https://bot.example.com/webhook/feishu");
    expect(callbackUrl("https://bot.example.com/", "wecom")).toBe("https://bot.example.com/webhook/wecom");
    expect(callbackUrl("http://localhost:8848", "qq")).toBe("http://localhost:8848/webhook/qq");
  });
});

describe("channel setup · missingRequired", () => {
  it("reports unfilled required fields, ignores optional", () => {
    expect(missingRequired("feishu", { appId: "a" })).toEqual(["appSecret"]);
    expect(missingRequired("feishu", { appId: "a", appSecret: "s" })).toEqual([]);
    // optional fields (verificationToken/encryptKey) never reported
    expect(missingRequired("feishu", { appId: "a", appSecret: "s" })).not.toContain("encryptKey");
  });
});

describe("channel setup · saveChannelConfig", () => {
  let cfgPath: string;
  beforeEach(() => { cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sky-chcfg-")), "config.yaml"); });
  afterEach(() => { try { fs.rmSync(path.dirname(cfgPath), { recursive: true, force: true }); } catch {} });

  it("writes channels.<id> and merges on re-save", () => {
    saveChannelConfig("feishu", { appId: "a", appSecret: "s" }, { configPath: cfgPath });
    const yaml = require("yaml");
    let cfg = yaml.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.feishu).toMatchObject({ appId: "a", appSecret: "s", enabled: true });

    // re-save adds a field without dropping the old ones
    saveChannelConfig("feishu", { encryptKey: "k" }, { configPath: cfgPath });
    cfg = yaml.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.feishu).toMatchObject({ appId: "a", appSecret: "s", encryptKey: "k" });
  });

  it("preserves other top-level config when writing a channel", () => {
    const yaml = require("yaml");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, yaml.stringify({ default_model: "gpt-4o", api_keys: { openai: "sk" } }));
    saveChannelConfig("qq", { appId: "1", secret: "x" }, { configPath: cfgPath });
    const cfg = yaml.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(cfg.default_model).toBe("gpt-4o");
    expect(cfg.api_keys.openai).toBe("sk");
    expect(cfg.channels.qq.appId).toBe("1");
  });
});

describe("channel setup · QR rendering", () => {
  it("renders a non-empty scannable block for a URL", () => {
    const qr = renderQR("https://open.feishu.cn/app");
    expect(qr.length).toBeGreaterThan(50);
    expect(qr).toMatch(/[█▀▄ ]/); // block-drawing characters
  });
});
