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
      "which", "replace_in_file", "diff_files", "gzip_file", "gunzip_file",
      "uuid", "random_string", "current_time", "sqlite_query",
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

describe("extra tools — batch 2", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-extra2-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function setup2() {
    const reg = new ToolRegistry();
    registerExtraTools(reg);
    return (name: string, params: Record<string, unknown> = {}) => reg.get(name)!.handler!(params);
  }

  it("which finds a real executable and reports misses", async () => {
    const call = setup2();
    const node = await call("which", { name: "node" });
    expect(node).toMatch(/node/);
    expect(await call("which", { name: "definitely-not-a-real-binary-xyz" })).toMatch(/not found/);
  });

  it("replace_in_file replaces ALL occurrences (literal and regex)", async () => {
    const call = setup2();
    const f = path.join(dir, "t.txt");
    fs.writeFileSync(f, "a a a", "utf-8");
    expect(await call("replace_in_file", { path: f, find: "a", replace: "b" })).toMatch(/3 occurrence/);
    expect(fs.readFileSync(f, "utf-8")).toBe("b b b");
    fs.writeFileSync(f, "x1 x2 x3", "utf-8");
    await call("replace_in_file", { path: f, find: "x\\d", replace: "N", regex: true });
    expect(fs.readFileSync(f, "utf-8")).toBe("N N N");
  });

  it("gzip_file then gunzip_file round-trips", async () => {
    const call = setup2();
    const f = path.join(dir, "data.txt");
    const payload = "中文 content ".repeat(50);
    fs.writeFileSync(f, payload, "utf-8");
    await call("gzip_file", { path: f });
    expect(fs.existsSync(f + ".gz")).toBe(true);
    const out = path.join(dir, "restored.txt");
    await call("gunzip_file", { path: f + ".gz", destination: out });
    expect(fs.readFileSync(out, "utf-8")).toBe(payload);
  });

  it("uuid, random_string and current_time produce valid output", async () => {
    const call = setup2();
    const ids = (await call("uuid", { count: 3 })).split("\n");
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await call("random_string", { length: 16, encoding: "hex" })).toHaveLength(16);
    expect(await call("current_time")).toMatch(/iso_utc: \d{4}-\d{2}-\d{2}T/);
  });
});

describe("extra tools — sqlite_query", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-sql-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function makeDb(file: string) {
    const initSqlJs = require("sql.js");
    const SQL = await (initSqlJs.default || initSqlJs)();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (1,'a'),(2,'b');");
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
  }

  it("reads rows, blocks writes by default, allows writes with the flag", async () => {
    const reg = new ToolRegistry();
    registerExtraTools(reg);
    const call = (p: Record<string, unknown>) => reg.get("sqlite_query")!.handler!(p);
    const file = path.join(dir, "x.db");
    await makeDb(file);

    const sel = await call({ path: file, sql: "SELECT name FROM t ORDER BY id" });
    expect(sel).toContain('"name": "a"');
    expect(sel).toContain('"name": "b"');

    const blocked = await call({ path: file, sql: "INSERT INTO t VALUES (3,'c')" });
    expect(blocked).toMatch(/blocked/);

    await call({ path: file, sql: "INSERT INTO t VALUES (3,'c')", allow_write: true });
    const after = await call({ path: file, sql: "SELECT COUNT(*) AS n FROM t" });
    expect(after).toContain('"n": 3'); // persisted to disk
  });
});

describe("extra tools — network guards", () => {
  it("http_request and download_file enforce SSRF", async () => {
    const { call } = setup();
    expect(await call("http_request", { url: "http://169.254.169.254/" })).toMatch(/private|blocked/);
    expect(await call("download_file", { url: "file:///etc/passwd", path: "/tmp/x" })).toMatch(/scheme/);
  });
});
