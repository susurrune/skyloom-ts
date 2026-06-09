import { describe, it, expect } from "vitest";
import { LoopGuard } from "../src/core/agent/guard";

function toolCall(name: string, args: any = {}) {
  return { id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } } as any;
}
const ok = (name: string) => ({ toolName: name, success: true, result: "ok" });
const fail = (name: string) => ({ toolName: name, success: false, result: "Error: boom" });

describe("LoopGuard", () => {
  it("no hints / no stop for a normal round", () => {
    const g = new LoopGuard();
    const d = g.observe("hello", [toolCall("read", { path: "a" })], [ok("read")]);
    expect(d.hints).toEqual([]);
    expect(d.stop).toBeUndefined();
  });

  it("hard-stops when the same tool signature repeats past the threshold", () => {
    const g = new LoopGuard();
    let last: any;
    for (let i = 0; i < 12; i++) last = g.observe("", [toolCall("spin", { n: 1 })], [ok("spin")]);
    expect(last.stop).toBeDefined();
    expect(last.stop.contentLine).toContain("repeated");
    expect(last.stop.note).toContain("Stopping");
  });

  it("injects a tool-loop hint once before hard-stopping", () => {
    const g = new LoopGuard();
    const hintRounds: string[][] = [];
    for (let i = 0; i < 12; i++) hintRounds.push(g.observe("", [toolCall("spin", { n: 1 })], [ok("spin")]).hints);
    const allHints = hintRounds.flat();
    expect(allHints.filter((h) => h.includes("[Tool loop]")).length).toBe(1); // once only
  });

  it("flags a narration loop when responses are near-identical", () => {
    const g = new LoopGuard();
    const text = "我正在分析这个问题并准备给出答案，请稍候。";
    g.observe(text, [], []);
    const d = g.observe(text, [], []); // same content again
    expect(d.hints.some((h) => h.includes("Stop narrating"))).toBe(true);
  });

  it("injects a recovery hint when most recent tool calls failed", () => {
    const g = new LoopGuard();
    const hints: string[] = [];
    for (let i = 0; i < 5; i++) hints.push(...g.observe("", [toolCall("t" + i)], [fail("t" + i)]).hints);
    expect(hints.some((h) => h.includes("[Recovery hint]"))).toBe(true);
  });

  it("hard-stops when the last 8 tool calls all failed", () => {
    const g = new LoopGuard();
    let last: any;
    // distinct tool names so the signature-loop guard doesn't fire first
    for (let i = 0; i < 8; i++) last = g.observe("", [toolCall("t" + i, { i })], [fail("t" + i)]);
    expect(last.stop).toBeDefined();
    expect(last.stop.contentLine).toContain("every recent tool call failed");
  });

  it("hard-stops on a search storm (>=12 distinct search calls)", () => {
    const g = new LoopGuard();
    let last: any;
    // cycle distinct search tools so the signature-loop guard doesn't fire first
    const tools = ["web_search", "fetch_page", "http_get"];
    for (let i = 0; i < 12; i++) last = g.observe("", [toolCall(tools[i % 3], { q: "x" + i })], [ok(tools[i % 3])]);
    expect(last.stop).toBeDefined();
    expect(last.stop.contentLine).toContain("excessive web searching");
  });

  it("ignores task_done in signature counting (never hard-stops on it)", () => {
    const g = new LoopGuard();
    let last: any;
    for (let i = 0; i < 15; i++) last = g.observe("", [toolCall("task_done", {})], [ok("task_done")]);
    expect(last.stop).toBeUndefined();
  });
});
