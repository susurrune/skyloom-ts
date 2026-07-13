import { describe, it, expect, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Memory } from "../src/core/memory";

/** addMessage mutates shortTerm through an async mutex — let microtasks flush. */
const flush = () => new Promise((r) => setTimeout(r, 15));

let tmpDirs: string[] = [];
function tmpConfig(shortTermLimit = 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-mem-"));
  tmpDirs.push(dir);
  return { dbPath: path.join(dir, "memory.db"), shortTermLimit, maxPersistedMessages: 2000 };
}

afterEach(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  tmpDirs = [];
});

describe("Memory · short-term (in-memory, no DB)", () => {
  it("makes a message visible SYNCHRONOUSLY (regression: first-turn crash)", () => {
    // Previously addMessage pushed inside an async mutex, so getMessages() in the
    // same tick missed the message — crashing chatImpl/chatStreamImpl on a fresh
    // session's first user message. The push must be synchronous.
    const mem = new Memory(tmpConfig(), "fog");
    mem.addMessage("user", "first message");
    const msgs = mem.getMessages(); // no flush!
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "user", content: "first message" });
  });

  it("records and returns messages in order", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    mem.addMessage("user", "hello");
    mem.addMessage("assistant", "hi there");
    await flush();
    const msgs = mem.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0].content).toBe("hello");
  });

  it("preserves tool-call metadata in getMessages", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    mem.addMessage("assistant", "", { toolCalls: [{ id: "t1", function: { name: "x" } }] });
    mem.addMessage("tool", "result", { name: "x", toolCallId: "t1" });
    await flush();
    const msgs = mem.getMessages();
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("t1");
    expect(toolMsg?.name).toBe("x");
  });

  it("prunes past the short-term limit but keeps system messages", async () => {
    const mem = new Memory(tmpConfig(3), "fog");
    mem.addMessage("system", "persona");
    for (let i = 0; i < 5; i++) mem.addMessage("user", `m${i}`);
    await flush();
    const msgs = mem.getMessages();
    expect(msgs.length).toBeLessThanOrEqual(3);
    expect(msgs.some((m) => m.role === "system" && m.content === "persona")).toBe(true);
    // most recent user message survives
    expect(msgs[msgs.length - 1].content).toBe("m4");
  });

  it("clearShortTerm keeps system messages", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    mem.addMessage("system", "persona");
    mem.addMessage("user", "hello");
    await flush();
    await mem.clearShortTerm();
    const msgs = mem.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
  });
});

describe("Memory · context window estimation", () => {
  it("counts CJK as heavier than ascii", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    mem.addMessage("user", "你好世界"); // 4 CJK chars
    await flush();
    const usage = mem.getContextWindowUsage();
    expect(usage.messageCount).toBe(1);
    expect(usage.totalChars).toBe(4);
    // CJK weight is 2/char => >= 8
    expect(usage.estimatedTokens).toBeGreaterThanOrEqual(8);
  });
});

describe("Memory · working memory", () => {
  it("set/get/clear round-trips", () => {
    const mem = new Memory(tmpConfig(), "fog");
    mem.setWorking("plan", { step: 1 });
    expect(mem.getWorking("plan")).toEqual({ step: 1 });
    expect(mem.getWorking("missing", "fallback")).toBe("fallback");
    mem.clearWorking();
    expect(mem.getWorking("plan")).toBeNull();
  });
});

describe("Memory · long-term (SQLite)", () => {
  it("remember / recall / forget round-trips", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    try {
      await mem.remember("favorite_lang", "typescript", "pref");
      const hits = await mem.recall("favorite_lang");
      expect(hits).toHaveLength(1);
      expect(hits[0].value).toBe("typescript");
      expect(hits[0].category).toBe("pref");

      await mem.forget("favorite_lang");
      expect(await mem.recall("favorite_lang")).toHaveLength(0);
    } finally {
      await mem.close();
    }
  });

  it("recall filters by category", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    try {
      await mem.remember("a", 1, "x");
      await mem.remember("b", 2, "y");
      const xs = await mem.recall(null, "x");
      expect(xs).toHaveLength(1);
      expect(xs[0].key).toBe("a");
    } finally {
      await mem.close();
    }
  });

  it("persists sessions + messages to disk and reloads across instances (regression)", async () => {
    // Previously persistDb() was never called, so nothing survived a restart and
    // session resume was impossible. close() must save; a fresh instance must reload.
    const cfg = tmpConfig(); // shared dbPath for both instances
    const a = new Memory(cfg, "fog");
    await a.initDb();
    const sid = await a.createSession("s1");
    a.addMessage("user", "the sky is blue");
    a.addMessage("assistant", "noted: sky is blue");
    await a.remember("fact1", "value1", "auto");
    await a.close(); // must flush to disk

    const b = new Memory(cfg, "fog");
    await b.initDb();
    const sessions = await b.listSessions();
    expect(sessions.some((s) => s.id === sid)).toBe(true);
    expect(await b.loadSession(sid)).toBe(true);
    const msgs = b.getMessages().filter((m) => m.role !== "system");
    expect(msgs.some((m) => String(m.content).includes("sky is blue"))).toBe(true);
    expect((await b.recall("fact1"))[0]?.value).toBe("value1"); // long-term memory survived too
    await b.close();
  });

  it("migrates the legacy shared empty-name database into Fog without losing history", async () => {
    const cfg = tmpConfig();
    const legacy = new Memory(cfg, "");
    await legacy.initDb();
    const sid = await legacy.createSession();
    legacy.addMessage("user", "旧版共享会话");
    await flush();
    await legacy.close();

    const fog = new Memory(cfg, "fog");
    await fog.initDb();
    try {
      expect((await fog.listSessions()).some((session) => session.id === sid)).toBe(true);
      expect(await fog.loadSession(sid)).toBe(true);
      expect(fog.getMessages().some((message) => message.content === "旧版共享会话")).toBe(true);
    } finally {
      await fog.close();
    }
  });

  it("uses the first user message as an unnamed session preview", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    try {
      const sid = await mem.createSession();
      mem.addMessage("user", "帮我排查登录接口偶发超时");
      mem.addMessage("assistant", "我先检查请求链路");
      await flush();

      const session = (await mem.listSessions()).find((item) => item.id === sid);
      expect(session?.preview).toBe("帮我排查登录接口偶发超时");
    } finally {
      await mem.close();
    }
  });

  it("derives a preview for legacy sessions whose stored preview is blank", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    try {
      const sid = await mem.createSession();
      mem.addMessage("user", "这是旧数据库里已有的第一条问题");
      await flush();
      (mem as any).dbRun("UPDATE sessions SET preview = '' WHERE id = ?", [sid]);

      const session = (await mem.listSessions()).find((item) => item.id === sid);
      expect(session?.preview).toBe("这是旧数据库里已有的第一条问题");
    } finally {
      await mem.close();
    }
  });

  it("does not report a session as created when the database write fails", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    const db = (mem as any).db;
    const originalRun = db.run.bind(db);
    db.run = (sql: string, params?: unknown[]) => {
      if (/^INSERT INTO sessions/i.test(sql)) throw new Error("disk write failed");
      return originalRun(sql, params);
    };

    try {
      await expect(mem.createSession("unwritten")).rejects.toThrow("Failed to create session");
      expect(mem.getActiveSession()).toBeNull();
      expect(await mem.listSessions()).toEqual([]);
    } finally {
      db.run = originalRun;
      await mem.close();
    }
  });

  it("rolls back message deletion when deleting the session fails", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    const sid = await mem.createSession("keep-on-failure");
    mem.addMessage("user", "must survive rollback");
    await flush();

    const db = (mem as any).db;
    const originalRun = db.run.bind(db);
    db.run = (sql: string, params?: unknown[]) => {
      if (/^DELETE FROM sessions/i.test(sql)) throw new Error("disk write failed");
      return originalRun(sql, params);
    };

    try {
      await expect(mem.deleteSession(sid)).rejects.toThrow("Failed to delete session");
      expect(mem.getActiveSession()).toBe(sid);
    } finally {
      db.run = originalRun;
    }

    expect(await mem.sessionExists(sid)).toBe(true);
    expect(mem.getMessages().some((message) => message.content === "must survive rollback")).toBe(true);
    await mem.close();
  });

  it("getMemoryStats returns a populated object", async () => {
    const mem = new Memory(tmpConfig(), "fog");
    await mem.initDb();
    try {
      await mem.remember("k", "v");
      const stats = await mem.getMemoryStats();
      expect(typeof stats).toBe("object");
      expect(stats).not.toBeNull();
    } finally {
      await mem.close();
    }
  });
});
