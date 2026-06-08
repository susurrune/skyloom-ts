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
