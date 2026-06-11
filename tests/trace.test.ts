import { describe, it, expect } from "vitest";
import { Tracer, traceTotals, renderTrace } from "../src/core/trace";

/** A controllable clock so span timings are deterministic. */
function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("Tracer", () => {
  it("builds a nested span tree with correct parentage and timing", () => {
    const c = clock();
    const tr = new Tracer({ now: c.now });
    const root = tr.startTrace("fix the bug", "fog");
    c.advance(10);
    const llm = tr.startSpan("chat", "llm", { model: "gpt-4o" });
    c.advance(100);
    llm.set({ promptTokens: 1200, completionTokens: 300, cost: 0.02 });
    llm.end("ok");
    const tool = tr.startSpan("read_file", "tool");
    c.advance(25);
    tool.end("ok");
    root.end("ok");
    const trace = tr.endTrace()!;

    expect(trace.spans).toHaveLength(3);
    const rootSpan = trace.spans.find((s) => s.kind === "turn")!;
    const llmSpan = trace.spans.find((s) => s.kind === "llm")!;
    const toolSpan = trace.spans.find((s) => s.kind === "tool")!;
    expect(llmSpan.parentId).toBe(rootSpan.id);
    expect(toolSpan.parentId).toBe(rootSpan.id); // sibling of llm, both under root
    expect(llmSpan.endMs! - llmSpan.startMs).toBe(100);
    expect(toolSpan.endMs! - toolSpan.startMs).toBe(25);
  });

  it("deeply nests spans by stack order", () => {
    const c = clock();
    const tr = new Tracer({ now: c.now });
    const root = tr.startTrace("t");
    const a = tr.startSpan("orchestrate", "orchestration");
    const b = tr.startSpan("subtask", "task");
    b.end();
    a.end();
    root.end();
    const trace = tr.endTrace()!;
    const rootSpan = trace.spans[0];
    const orch = trace.spans.find((s) => s.kind === "orchestration")!;
    const task = trace.spans.find((s) => s.kind === "task")!;
    expect(orch.parentId).toBe(rootSpan.id);
    expect(task.parentId).toBe(orch.id);
  });

  it("end() is idempotent and endTrace closes dangling spans", () => {
    const c = clock();
    const tr = new Tracer({ now: c.now });
    tr.startTrace("t");
    const s = tr.startSpan("hang", "tool");
    c.advance(5);
    s.end("ok");
    const firstEnd = s.span!.endMs;
    c.advance(50);
    s.end("error"); // second call ignored
    expect(s.span!.endMs).toBe(firstEnd);
    expect(s.span!.status).toBe("ok");

    const open = tr.startSpan("never-ended", "tool"); // left open on purpose
    void open;
    const trace = tr.endTrace()!;
    const dangling = trace.spans.find((x) => x.name === "never-ended")!;
    expect(dangling.endMs).not.toBeNull();
    expect(dangling.status).toBe("ok");
  });

  it("aggregates tokens, cost and status counts", () => {
    const c = clock();
    const tr = new Tracer({ now: c.now });
    tr.startTrace("t");
    tr.startSpan("llm1", "llm", { promptTokens: 100, completionTokens: 50, cost: 0.01 }).end("ok");
    tr.startSpan("llm2", "llm", { totalTokens: 200, cost: 0.02 }).end("ok");
    tr.startSpan("tool1", "tool").end("error", { error: "boom" });
    c.advance(0);
    const trace = tr.endTrace()!;
    const tot = traceTotals(trace);
    expect(tot.llmCalls).toBe(2);
    expect(tot.toolCalls).toBe(1);
    expect(tot.errors).toBe(1);
    expect(tot.totalTokens).toBe(150 + 200);
    expect(tot.cost).toBeCloseTo(0.03, 6);
  });

  it("keeps a ring buffer of recent traces", () => {
    const tr = new Tracer({ maxFinished: 3 });
    for (let i = 0; i < 5; i++) { tr.startTrace(`t${i}`); tr.endTrace(); }
    const recent = tr.recent(10);
    expect(recent).toHaveLength(3);
    expect(recent.map((t) => t.label)).toEqual(["t2", "t3", "t4"]);
    expect(tr.last()!.label).toBe("t4");
  });

  it("a disabled tracer is a no-op and never throws", () => {
    const tr = new Tracer({ enabled: false });
    const root = tr.startTrace("t");
    root.set({ x: 1 }).end();
    tr.startSpan("s", "tool").end();
    expect(tr.endTrace()).toBeNull();
    expect(tr.last()).toBeNull();
  });

  it("renders a readable tree with totals", () => {
    const c = clock();
    const tr = new Tracer({ now: c.now });
    tr.startTrace("ship feature", "rain");
    c.advance(5);
    const llm = tr.startSpan("chat", "llm", { model: "gpt-4o" });
    c.advance(120);
    llm.end("ok", { promptTokens: 1000, completionTokens: 200, cost: 0.015 });
    tr.startSpan("write_file", "tool").end("error", { error: "disk full" });
    const trace = tr.endTrace()!;
    const out = renderTrace(trace);
    expect(out).toContain("ship feature");
    expect(out).toContain("llm:chat");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("tool:write_file");
    expect(out).toContain("✗");
    expect(out).toContain("disk full");
    expect(out).toMatch(/1 llm · 1 tool · 1200 tokens/);
  });
});
