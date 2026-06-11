import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry } from "../src/core/tool";
import { registerExtraTools } from "../src/tools/extra";
import { SecurityContext, DangerLevel } from "../src/core/security";

function setup() {
  const reg = new ToolRegistry();
  registerExtraTools(reg);
  const call = (name: string, params: Record<string, unknown> = {}) =>
    reg.get(name)!.handler!(params);
  return { reg, call };
}

describe("extra tools — registration & gating", () => {
  it("registers the full capability set", () => {
    const { reg } = setup();
    const names = reg.listNames();
    for (const n of [
      "copy_file", "move_file", "make_directory", "append_file", "file_info",
      "hash", "base64", "json_query", "http_request", "download_file",
      "dns_lookup", "port_check", "git_add", "git_branch", "git_checkout",
      "git_push", "git_pull", "env_get", "disk_usage", "clipboard_read", "clipboard_write",
    ]) expect(names, n).toContain(n);
  });

  it("assigns sensible danger levels", () => {
    const sec = new SecurityContext();
    expect(sec.getDangerLevel("git_push")).toBe(DangerLevel.HIGH);
    expect(sec.getDangerLevel("download_file")).toBe(DangerLevel.MEDIUM);
    expect(sec.getDangerLevel("make_directory")).toBe(DangerLevel.LOW);
    expect(sec.getDangerLevel("hash")).toBe(DangerLevel.SAFE);
    expect(sec.getDangerLevel("json_query")).toBe(DangerLevel.SAFE);
  });
});

describe("extra tools — pure helpers", () => {
  it("hash computes sha256", async () => {
    const { call } = setup();
    expect(await call("hash", { text: "abc" }))
      .toBe("sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await call("hash", { text: "abc", algorithm: "md5" }))
      .toBe("md5: 900150983cd24fb0d6963f7d28e17f72");
  });

  it("base64 round-trips", async () => {
    const { call } = setup();
    const enc = await call("base64", { text: "你好 world" });
    expect(await call("base64", { text: enc, mode: "decode" })).toBe("你好 world");
  });

  it("json_query navigates a dot path", async () => {
    const { call } = setup();
    const json = JSON.stringify({ user: { roles: [{ name: "admin" }] } });
    expect(await call("json_query", { json, query: "user.roles.0.name" })).toBe("admin");
    expect(await call("json_query", { json, query: "user.missing" })).toMatch(/not found/);
  });

  it("env_get redacts secret-looking names", async () => {
    const { call } = setup();
    process.env.SKY_TEST_PLAIN = "visible";
    process.env.SKY_TEST_API_KEY = "sk-supersecret";
    try {
      expect(await call("env_get", { name: "SKY_TEST_PLAIN" })).toBe("SKY_TEST_PLAIN=visible");
      const redacted = await call("env_get", { name: "SKY_TEST_API_KEY" });
      expect(redacted).toContain("redacted");
      expect(redacted).not.toContain("supersecret");
    } finally {
      delete process.env.SKY_TEST_PLAIN; delete process.env.SKY_TEST_API_KEY;
    }
  });
});

describe("extra tools — filesystem", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-extra-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("make_directory, append_file, file_info, copy_file, move_file", async () => {
    const { call } = setup();
    const sub = path.join(dir, "a", "b");
    expect(await call("make_directory", { path: sub })).toMatch(/Created/);
    expect(fs.existsSync(sub)).toBe(true);

    const f = path.join(sub, "note.txt");
    await call("append_file", { path: f, content: "hello " });
    await call("append_file", { path: f, content: "world" });
    expect(fs.readFileSync(f, "utf-8")).toBe("hello world");

    const info = await call("file_info", { path: f });
    expect(info).toMatch(/type: file/);
    expect(info).toMatch(/size: 11 bytes/);

    const copy = path.join(dir, "copy.txt");
    await call("copy_file", { source: f, destination: copy });
    expect(fs.readFileSync(copy, "utf-8")).toBe("hello world");

    const moved = path.join(dir, "moved.txt");
    await call("move_file", { source: copy, destination: moved });
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(moved, "utf-8")).toBe("hello world");
  });

  it("respects the workspace fence", async () => {
    const { call } = setup();
    process.env.SKYLOOM_WORKSPACE_FENCE = "1";
    process.env.SKYLOOM_WORKSPACE_ROOT = dir;
    try {
      expect(await call("make_directory", { path: "/etc/sky-should-not" })).toMatch(/路径越界/);
      expect(await call("file_info", { path: path.join(dir, "ok") })).toMatch(/Error|type/); // inside fence (not blocked)
    } finally {
      delete process.env.SKYLOOM_WORKSPACE_FENCE; delete process.env.SKYLOOM_WORKSPACE_ROOT;
    }
  });
});

describe("extra tools — network guards", () => {
  it("http_request and download_file enforce SSRF", async () => {
    const { call } = setup();
    expect(await call("http_request", { url: "http://169.254.169.254/" })).toMatch(/private|blocked/);
    expect(await call("download_file", { url: "file:///etc/passwd", path: "/tmp/x" })).toMatch(/scheme/);
  });
});
