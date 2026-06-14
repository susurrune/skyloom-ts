import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import { resolveSecret, TokenCache } from "../src/gateway/helpers";
import { describeMedia } from "../src/gateway/types";
import { buildAdapters, SUPPORTED_CHANNELS } from "../src/gateway/registry";
import { decryptFeishu, createFeishuAdapter } from "../src/gateway/channels/feishu";
import { wecomSignature, decryptWecom, createWecomAdapter } from "../src/gateway/channels/wecom";
import { qqSeed, qqSignValidation, qqVerify, createQQAdapter } from "../src/gateway/channels/qq";
import type { RawRequest } from "../src/gateway/types";

function req(partial: Partial<RawRequest> & { body?: Buffer | string }): RawRequest {
  return {
    method: partial.method || "POST",
    headers: partial.headers || {},
    query: partial.query || new URLSearchParams(),
    body: typeof partial.body === "string" ? Buffer.from(partial.body) : (partial.body || Buffer.alloc(0)),
  };
}

describe("gateway · helpers", () => {
  it("resolveSecret: literal, env-ref object, env fallback, undefined", () => {
    expect(resolveSecret("abc", {})).toBe("abc");
    expect(resolveSecret({ source: "env", id: "X" }, { X: "v" })).toBe("v");
    expect(resolveSecret(undefined, { FOO: "bar" }, "FOO")).toBe("bar");
    expect(resolveSecret(undefined, {}, "MISSING")).toBeUndefined();
  });

  it("TokenCache fetches once then caches until near expiry", async () => {
    let calls = 0;
    const tc = new TokenCache(async () => { calls++; return { token: `t${calls}`, expiresInSec: 7200 }; });
    expect(await tc.get()).toBe("t1");
    expect(await tc.get()).toBe("t1"); // cached
    expect(calls).toBe(1);
    tc.invalidate();
    expect(await tc.get()).toBe("t2");
  });
});

describe("gateway · media", () => {
  it("describeMedia renders a compact readable line", () => {
    expect(describeMedia(undefined)).toBe("");
    expect(describeMedia([])).toBe("");
    expect(describeMedia([{ kind: "image", ref: "img_1" }])).toBe("[image: img_1]");
    expect(describeMedia([
      { kind: "file", filename: "report.pdf" },
      { kind: "audio", ref: "a_2" },
    ])).toBe("[file: report.pdf] [audio: a_2]");
  });

  it("feishu normalizes an image message to a media attachment", async () => {
    const a = createFeishuAdapter({ appId: "a", appSecret: "s" }, {})!;
    const payload = {
      header: { event_id: "img1", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "o" } },
        message: { chat_id: "c", message_type: "image", content: JSON.stringify({ image_key: "img_xxx" }) },
      },
    };
    const out = await a.handleWebhook(req({ body: JSON.stringify(payload) }));
    expect(out.message?.media?.[0]).toMatchObject({ kind: "image", ref: "img_xxx" });
  });

  it("wecom normalizes a voice message to an audio attachment", async () => {
    // reuse the wecom encrypt helper from below via a fresh adapter
    const aesKey = crypto.randomBytes(32).toString("base64").slice(0, 43);
    const key = Buffer.from(aesKey + "=", "base64");
    const iv = key.subarray(0, 16);
    const inner = "<xml><MsgType><![CDATA[voice]]></MsgType><FromUserName><![CDATA[u9]]></FromUserName><MediaId><![CDATA[mid]]></MediaId><Format><![CDATA[amr]]></Format></xml>";
    const rand = crypto.randomBytes(16);
    const msgBuf = Buffer.from(inner, "utf8");
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(msgBuf.length, 0);
    const full = Buffer.concat([rand, lenBuf, msgBuf, Buffer.from("corp1", "utf8")]);
    const pad = 32 - (full.length % 32);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv); cipher.setAutoPadding(false);
    const enc = Buffer.concat([cipher.update(Buffer.concat([full, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
    const a = createWecomAdapter({ corpId: "corp1", corpSecret: "s", token: "tok", encodingAesKey: aesKey, agentId: 1 }, {})!;
    const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
    const q = new URLSearchParams({ msg_signature: wecomSignature("tok", "1", "n", enc), timestamp: "1", nonce: "n" });
    const out = await a.handleWebhook(req({ method: "POST", query: q, body }));
    expect(out.message?.media?.[0]).toMatchObject({ kind: "audio", ref: "mid" });
  });
});

describe("gateway · registry", () => {
  it("lists the three supported channels", () => {
    expect(SUPPORTED_CHANNELS.sort()).toEqual(["feishu", "qq", "wecom"]);
  });
  it("builds only configured channels; skips disabled and unconfigured", () => {
    const adapters = buildAdapters(
      {
        feishu: { appId: "a", appSecret: "s" },
        wecom: { enabled: false, corpId: "c", corpSecret: "s", token: "t", encodingAesKey: "k" },
        // qq: absent + no env → not built
      },
      {},
    );
    expect([...adapters.keys()]).toEqual(["feishu"]);
  });
  it("can enable a channel from env vars alone", () => {
    const adapters = buildAdapters({}, { QQ_BOT_APPID: "123", QQ_BOT_SECRET: "secretsecretsecret" });
    expect(adapters.has("qq")).toBe(true);
  });
});

describe("gateway · feishu", () => {
  it("AES round-trips (encrypt with the same scheme, then decrypt)", () => {
    const key = "my-encrypt-key";
    const aesKey = crypto.createHash("sha256").update(key).digest();
    const iv = crypto.randomBytes(16);
    const plain = Buffer.from(JSON.stringify({ type: "url_verification", challenge: "xyz" }), "utf8");
    const pad = 16 - (plain.length % 16);
    const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const enc = Buffer.concat([iv, cipher.update(padded), cipher.final()]).toString("base64");
    const out = JSON.parse(decryptFeishu(enc, key));
    expect(out.challenge).toBe("xyz");
  });

  it("answers the url_verification challenge", async () => {
    const a = createFeishuAdapter({ appId: "a", appSecret: "s" }, {})!;
    const out = await a.handleWebhook(req({ body: JSON.stringify({ type: "url_verification", challenge: "C1" }) }));
    expect(out.response?.status).toBe(200);
    expect(JSON.parse(out.response!.body!).challenge).toBe("C1");
    expect(out.message).toBeUndefined();
  });

  it("normalizes an im.message.receive_v1 text event", async () => {
    const a = createFeishuAdapter({ appId: "a", appSecret: "s" }, {})!;
    const payload = {
      header: { event_id: "e1", event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_123" } },
        message: { chat_id: "oc_chat", message_type: "text", content: JSON.stringify({ text: "@_user_1 你好" }) },
      },
    };
    const out = await a.handleWebhook(req({ body: JSON.stringify(payload) }));
    expect(out.message?.channel).toBe("feishu");
    expect(out.message?.text).toBe("你好");
    expect(out.message?.replyTo.chatId).toBe("oc_chat");
  });

  it("dedupes a redelivered event_id", async () => {
    const a = createFeishuAdapter({ appId: "a", appSecret: "s" }, {})!;
    const payload = {
      header: { event_id: "dup", event_type: "im.message.receive_v1" },
      event: { sender: { sender_id: { open_id: "o" } }, message: { chat_id: "c", message_type: "text", content: JSON.stringify({ text: "hi" }) } },
    };
    const first = await a.handleWebhook(req({ body: JSON.stringify(payload) }));
    const second = await a.handleWebhook(req({ body: JSON.stringify(payload) }));
    expect(first.message).toBeDefined();
    expect(second.message).toBeUndefined();
  });

  it("rejects a bad verification token", async () => {
    const a = createFeishuAdapter({ appId: "a", appSecret: "s", verificationToken: "good" }, {})!;
    const out = await a.handleWebhook(req({ body: JSON.stringify({ header: { token: "bad", event_type: "im.message.receive_v1" }, event: {} }) }));
    expect(out.response?.status).toBe(403);
  });
});

describe("gateway · wecom", () => {
  const aesKey = crypto.randomBytes(32).toString("base64").slice(0, 43); // 43-char EncodingAESKey

  function encryptWecom(message: string, receiveId: string): string {
    const key = Buffer.from(aesKey + "=", "base64");
    const iv = key.subarray(0, 16);
    const rand = crypto.randomBytes(16);
    const msgBuf = Buffer.from(message, "utf8");
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(msgBuf.length, 0);
    const full = Buffer.concat([rand, lenBuf, msgBuf, Buffer.from(receiveId, "utf8")]);
    const pad = 32 - (full.length % 32);
    const padded = Buffer.concat([full, Buffer.alloc(pad, pad)]);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  }

  it("signature matches the sorted-sha1 scheme", () => {
    const sig = wecomSignature("tok", "100", "nonce", "enc");
    const expected = crypto.createHash("sha1").update(["tok", "100", "nonce", "enc"].sort().join("")).digest("hex");
    expect(sig).toBe(expected);
  });

  it("decrypts an AES message round-trip", () => {
    const enc = encryptWecom("hello world", "corp1");
    const { message, receiveId } = decryptWecom(enc, aesKey);
    expect(message).toBe("hello world");
    expect(receiveId).toBe("corp1");
  });

  it("verifies GET echostr and echoes the decrypted value", async () => {
    const a = createWecomAdapter({ corpId: "corp1", corpSecret: "s", token: "tok", encodingAesKey: aesKey, agentId: 1 }, {})!;
    const echo = encryptWecom("echo-plain", "corp1");
    const q = new URLSearchParams({ msg_signature: wecomSignature("tok", "1", "n", echo), timestamp: "1", nonce: "n", echostr: echo });
    const out = await a.handleWebhook(req({ method: "GET", query: q }));
    expect(out.response?.status).toBe(200);
    expect(out.response?.body).toBe("echo-plain");
  });

  it("rejects a bad signature on GET", async () => {
    const a = createWecomAdapter({ corpId: "corp1", corpSecret: "s", token: "tok", encodingAesKey: aesKey, agentId: 1 }, {})!;
    const q = new URLSearchParams({ msg_signature: "wrong", timestamp: "1", nonce: "n", echostr: "x" });
    const out = await a.handleWebhook(req({ method: "GET", query: q }));
    expect(out.response?.status).toBe(403);
  });

  it("normalizes an encrypted text message POST", async () => {
    const a = createWecomAdapter({ corpId: "corp1", corpSecret: "s", token: "tok", encodingAesKey: aesKey, agentId: 1 }, {})!;
    const inner = "<xml><MsgType><![CDATA[text]]></MsgType><FromUserName><![CDATA[user42]]></FromUserName><Content><![CDATA[在吗]]></Content></xml>";
    const enc = encryptWecom(inner, "corp1");
    const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
    const q = new URLSearchParams({ msg_signature: wecomSignature("tok", "1", "n", enc), timestamp: "1", nonce: "n" });
    const out = await a.handleWebhook(req({ method: "POST", query: q, body }));
    expect(out.message?.text).toBe("在吗");
    expect(out.message?.replyTo.toUser).toBe("user42");
  });
});

describe("gateway · qq", () => {
  it("seed is the secret repeated to 32 bytes", () => {
    expect(qqSeed("abc").length).toBe(32);
    expect(qqSeed("abc").toString("utf8").startsWith("abcabc")).toBe(true);
  });

  it("validation signature verifies against the derived public key", () => {
    const secret = "supersecretseedvalue";
    const sig = qqSignValidation(secret, "1700000000", "PLAIN");
    // Verify the signature with the same derivation the adapter uses.
    expect(qqVerify(secret, "1700000000", Buffer.from("PLAIN"), sig)).toBe(true);
  });

  it("answers the op=13 validation handshake", async () => {
    const a = createQQAdapter({ appId: "123", secret: "supersecretseedvalue" }, {})!;
    const out = await a.handleWebhook(req({ body: JSON.stringify({ op: 13, d: { plain_token: "PT", event_ts: "1700000000" } }) }));
    expect(out.response?.status).toBe(200);
    const parsed = JSON.parse(out.response!.body!);
    expect(parsed.plain_token).toBe("PT");
    expect(typeof parsed.signature).toBe("string");
  });

  it("rejects a push with a bad signature header", async () => {
    const a = createQQAdapter({ appId: "123", secret: "supersecretseedvalue" }, {})!;
    const out = await a.handleWebhook(req({
      headers: { "x-signature-ed25519": "00", "x-signature-timestamp": "1" },
      body: JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { content: "hi" } }),
    }));
    expect(out.response?.status).toBe(403);
  });

  it("normalizes a signed GROUP_AT_MESSAGE_CREATE", async () => {
    const secret = "supersecretseedvalue";
    const a = createQQAdapter({ appId: "123", secret }, {})!;
    const body = JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "m1", content: "<@!123> 你好", group_openid: "g1", author: { member_openid: "u1" } } });
    const ts = "1700000000";
    const sig = (() => {
      const seed = qqSeed(secret);
      const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
      const priv = crypto.createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(body)]), priv).toString("hex");
    })();
    const out = await a.handleWebhook(req({ headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts }, body }));
    expect(out.message?.text).toBe("你好");
    expect(out.message?.replyTo.kind).toBe("group");
    expect(out.message?.replyTo.groupOpenid).toBe("g1");
  });
});
