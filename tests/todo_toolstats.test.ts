import { describe, it, expect } from "vitest";
import { parseTodoItems, renderTodoList, createTodoTool, TODO_WORKING_KEY } from "../src/tools/todo";
import { clampToolResult } from "../src/core/agent";
import { ToolRegistry } from "../src/core/tool";

describe("todo_write 任务清单", () => {
  it("parses a JSON array with status validation and defaults", () => {
    const { items, error } = parseTodoItems('[{"text":"调研","status":"done"},{"text":"实现","status":"active"},{"text":"测试"}]');
    expect(error).toBe("");
    expect(items).toEqual([
      { text: "调研", status: "done" },
      { text: "实现", status: "active" },
      { text: "测试", status: "pending" },
    ]);
    // plain string items are accepted as pending
    expect(parseTodoItems('["a","b"]').items).toEqual([
      { text: "a", status: "pending" },
      { text: "b", status: "pending" },
    ]);
  });

  it("rejects malformed input", () => {
    expect(parseTodoItems("not json").items).toBeNull();
    expect(parseTodoItems('{"text":"x"}').items).toBeNull();
    expect(parseTodoItems('[{"text":""}]').items).toBeNull();
    expect(parseTodoItems(JSON.stringify(Array(25).fill({ text: "x" }))).items).toBeNull();
  });

  it("renderTodoList shows progress and per-item marks", () => {
    const out = renderTodoList([
      { text: "调研", status: "done" },
      { text: "实现", status: "active" },
      { text: "测试", status: "pending" },
    ]);
    expect(out).toContain("任务清单 1/3");
    expect(out).toContain("✓ 调研");
    expect(out).toContain("◐ 实现");
    expect(out).toContain("· 测试");
  });

  it("the tool stores the list in working memory (survives compaction)", async () => {
    const working: Record<string, any> = {};
    const fakeAgent = { memory: { setWorking: (k: string, v: any) => { working[k] = v; } } };
    const tool = createTodoTool(fakeAgent);
    const out = String(await tool.handler!({ items: '[{"text":"步骤一","status":"active"}]' }));
    expect(out).toContain("✓ 任务清单 0/1");
    expect(working[TODO_WORKING_KEY]).toEqual([{ text: "步骤一", status: "active" }]);
    expect(String(await tool.handler!({ items: "bad" }))).toContain("✗");
  });
});

describe("工具结果上下文保护", () => {
  it("passes small results through untouched", () => {
    expect(clampToolResult("short", 100)).toBe("short");
  });

  it("clamps oversized results keeping head + tail with a hint", () => {
    const big = "H".repeat(9000) + "M".repeat(9000) + "T".repeat(9000);
    const out = clampToolResult(big, 12000);
    expect(out.length).toBeLessThan(13000);
    expect(out.startsWith("HHHH")).toBe(true);
    expect(out.endsWith("TTTT")).toBe(true);
    expect(out).toContain("中间省略");
    expect(out).toContain("offset");
  });
});

describe("ToolRegistry 运行时统计", () => {
  it("tracks calls / failures / cache hits / avg duration", async () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "ok_tool", description: "test tool", parameters: [], cacheable: true,
      handler: async () => "fine",
    });
    reg.register({
      name: "bad_tool", description: "failing test tool", parameters: [], maxRetries: 0,
      handler: async () => { throw new Error("boom"); },
    });

    await reg.execute("ok_tool", { q: 1 });
    await reg.execute("ok_tool", { q: 1 }); // cache hit
    await reg.execute("bad_tool", {});

    const stats = reg.getStats();
    const ok = stats.find(s => s.name === "ok_tool")!;
    expect(ok.calls).toBe(1);
    expect(ok.cacheHits).toBe(1);
    expect(ok.failures).toBe(0);
    const bad = stats.find(s => s.name === "bad_tool")!;
    expect(bad.calls).toBe(1);
    expect(bad.failures).toBe(1);
    expect(bad.breaker).toBeDefined();
  });
});
