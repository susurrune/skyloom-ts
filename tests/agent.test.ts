import { describe, it, expect } from "vitest";
import { FogAgent } from "../src/agents/fog";
import { MessageBus } from "../src/core/bus";
import { ToolRegistry } from "../src/core/tool";
import { SkillRegistry } from "../src/core/skill";

/**
 * Characterization tests for the agent chat/tool loop, driven by a scripted
 * mock LLM (no network). These lock in the behavior of the ~275-line hot path
 * (chatStreamImpl / llmLoop / tool execution / anti-loop guard) so it can be
 * refactored safely (Phase 3) — and they guard against regressions like the
 * first-message crash.
 */

interface Turn { content?: string; toolCalls?: { name: string; args?: any }[]; reasoning?: string }

class MockLLM {
  calls = 0;
  constructor(private turns: Turn[]) {}
  private turn(): Turn { const t = this.turns[Math.min(this.calls, this.turns.length - 1)]; this.calls++; return t || {}; }
  private toolCallObjs(t: Turn) {
    return (t.toolCalls || []).map((tc, i) => ({
      id: `call_${this.calls}_${i}`, type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
    }));
  }
  async *streamWithTools(): AsyncGenerator<any> {
    const t = this.turn();
    if (t.reasoning) yield { type: "reasoning", text: t.reasoning };
    if (t.content) yield { type: "content", text: t.content };
    for (const tc of this.toolCallObjs(t)) yield { type: "tool_call", toolCall: tc };
    yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
  }
  async complete(): Promise<any> {
    const t = this.turn();
    return { content: t.content || "", toolCalls: this.toolCallObjs(t), model: "mock", usage: { promptTokens: 1, completionTokens: 1 }, cost: 0, truncated: false };
  }
  getTotalCost() { return 0; }
  getModel() { return "mock"; }
  setLogger() { /* noop */ }
}

function makeAgent(turns: Turn[], tools: { name: string; handler: (a: any) => Promise<string>; idempotent?: boolean }[] = []) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register({ name: t.name, description: t.name, handler: t.handler, idempotent: t.idempotent });
  const config = { agents: { fog: {} }, llm: { language: "zh" }, memory: { shortTermLimit: 100, dbPath: "/tmp/sky-test" } };
  const agent = new FogAgent(config as any, new MockLLM(turns) as any, new MessageBus(), reg, new SkillRegistry());
  return agent;
}

async function collect(gen: AsyncGenerator<any>, cap = 500): Promise<any[]> {
  const evs: any[] = [];
  for await (const ev of gen) { evs.push(ev); if (evs.length > cap) break; }
  return evs;
}

describe("agent · chat loop (mock LLM)", () => {
  it("streams a simple reply and records both messages", async () => {
    const agent = makeAgent([{ content: "你好，我是雾。" }]);
    const evs = await collect(agent.chatStream("你好"));
    const text = evs.filter((e) => e.type === "content").map((e) => e.text).join("");
    expect(text).toContain("你好，我是雾。");

    const msgs = agent.memory.getMessages();
    expect(msgs[0]).toMatchObject({ role: "user", content: "你好" });   // regression: user msg present
    expect(msgs.some((m) => m.role === "assistant" && String(m.content).includes("雾"))).toBe(true);
  });

  it("blocking chat() returns the reply", async () => {
    const agent = makeAgent([{ content: "答案是 42" }]);
    const reply = await agent.chat("问题？");
    expect(reply).toContain("42");
  });

  it("streams reasoning before content", async () => {
    const agent = makeAgent([{ reasoning: "先想一下…", content: "结论。" }]);
    const evs = await collect(agent.chatStream("?"));
    expect(evs.some((e) => e.type === "reasoning")).toBe(true);
    expect(evs.filter((e) => e.type === "content").map((e) => e.text).join("")).toContain("结论。");
  });

  it("executes a tool call then produces the final answer", async () => {
    let received: any = null;
    const agent = makeAgent(
      [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, { content: "工具回显: hi" }],
      [{ name: "echo", handler: async (a) => { received = a; return `echo:${a.text}`; } }],
    );
    const evs = await collect(agent.chatStream("用 echo 工具"));
    expect(received).toEqual({ text: "hi" });                       // tool actually ran with parsed args
    expect(evs.some((e) => e.type === "tool_status" && e.tool_name === "echo")).toBe(true);
    expect(evs.some((e) => e.type === "tool_done" && e.tool_name === "echo" && e.success)).toBe(true);
    expect(evs.filter((e) => e.type === "content").map((e) => e.text).join("")).toContain("工具回显");
    // tool result recorded to memory
    expect(agent.memory.getMessages().some((m) => m.role === "tool" && String(m.content).includes("echo:hi"))).toBe(true);
  });

  it("terminates (does not loop forever) when the model repeats the same tool call", async () => {
    // Script the same tool call far beyond the round cap; the anti-loop guard must stop it.
    const turns: Turn[] = Array.from({ length: 60 }, () => ({ toolCalls: [{ name: "spin", args: { n: 1 } }] }));
    const llm = new MockLLM(turns);
    const reg = new ToolRegistry();
    reg.register({ name: "spin", description: "spin", handler: async () => "still spinning" });
    const config = { agents: { fog: {} }, llm: {}, memory: { shortTermLimit: 200, dbPath: "/tmp/sky-test" } };
    const agent = new FogAgent(config as any, llm as any, new MessageBus(), reg, new SkillRegistry());

    const evs = await collect(agent.chatStream("loop please"), 2000);
    // It must finish (the generator returns), not hang, and not call the model unboundedly.
    expect(evs.some((e) => e.type === "done")).toBe(true);
    expect(llm.calls).toBeLessThan(50); // bounded by the round cap / guard, not 60+
  }, 15000);
});

describe("agent · context window (catalog-aware compaction)", () => {
  it("contextUsage uses the active model's real window from the catalog", () => {
    const agent = makeAgent([{ content: "x" }]);
    (agent as any).config.agents.fog.model = "mixtral-8x7b"; // 32768
    expect(agent.contextUsage().maxTokens).toBe(32768);
    expect(agent.contextUsage().model).toBe("mixtral-8x7b");
    (agent as any).config.agents.fog.model = "gemini-2.5-pro"; // 1048576
    expect(agent.contextUsage().maxTokens).toBe(1048576);
  });

  it("auto-compaction triggers for a small window but not a large one (same history)", () => {
    const agent = makeAgent([{ content: "x" }]);
    const big = "字".repeat(800); // CJK ~2 tokens/char
    for (let i = 0; i < 20; i++) agent.memory.addMessage("user", big); // ~32k tokens

    (agent as any).config.agents.fog.model = "mixtral-8x7b"; // 32768 window -> over budget
    expect((agent as any).shouldAutoCompact()).toBe(true);

    (agent as any).config.agents.fog.model = "gemini-2.5-pro"; // 1M window -> fine
    expect((agent as any).shouldAutoCompact()).toBe(false);
  });
});

describe("agent · interrupt (Ctrl-C)", () => {
  it("stops between rounds on abort and preserves partial output", async () => {
    const controller = new AbortController();
    // Round 1 streams some content + a tool call; the tool aborts the signal.
    // Round 2 must never run.
    const turns: Turn[] = [
      { content: "部分内容已生成…", toolCalls: [{ name: "spin", args: {} }] },
      { content: "不应出现的第二轮" },
    ];
    const reg = new ToolRegistry();
    reg.register({ name: "spin", description: "spin", handler: async () => { controller.abort(); return "spun"; } });
    const config = { agents: { fog: {} }, llm: {}, memory: { shortTermLimit: 200, dbPath: "/tmp/sky-test" } };
    const agent = new FogAgent(config as any, new MockLLM(turns) as any, new MessageBus(), reg, new SkillRegistry());

    const evs = await collect(agent.chatStream("go", controller.signal));
    const text = evs.filter((e) => e.type === "content").map((e) => e.text).join("");

    expect(evs.some((e) => e.type === "interrupted")).toBe(true);
    expect(text).toContain("部分内容已生成");      // partial output kept
    expect(text).not.toContain("第二轮");          // round 2 never streamed
    // partial assistant content is in memory
    expect(agent.memory.getMessages().some((m) => m.role === "assistant" && String(m.content).includes("部分内容"))).toBe(true);
  });

  it("skips queued tools in a round once the signal aborts (cooperative cancel)", async () => {
    const controller = new AbortController();
    // One round requests three tools. Serial execution (tool_concurrency: 1) +
    // the first tool aborting → tools 2 and 3 must be skipped, not run.
    let ran = 0;
    const turns: Turn[] = [
      { content: "批量执行…", toolCalls: [{ name: "step", args: { n: 1 } }, { name: "step", args: { n: 2 } }, { name: "step", args: { n: 3 } }] },
      { content: "不应出现的第二轮" },
    ];
    const reg = new ToolRegistry();
    reg.register({ name: "step", description: "step", cacheable: false, handler: async (a: any) => { ran++; if (a.n === 1) controller.abort(); return `did ${a.n}`; } });
    const config = { agents: { fog: {} }, llm: { tool_concurrency: 1 }, memory: { shortTermLimit: 200, dbPath: "/tmp/sky-test" } };
    const agent = new FogAgent(config as any, new MockLLM(turns) as any, new MessageBus(), reg, new SkillRegistry());

    const evs = await collect(agent.chatStream("go", controller.signal));

    // Only the first tool actually executed.
    expect(ran).toBe(1);
    // The other two were reported as cancelled, not run.
    const cancelled = evs.filter((e) => e.type === "tool_done" && String(e.result).includes("[cancelled]"));
    expect(cancelled.length).toBe(2);
    // And the turn stopped instead of running round 2.
    expect(evs.some((e) => e.type === "interrupted")).toBe(true);
  });
});

describe("agent · run tracing", () => {
  it("produces a turn → llm → tool span tree with token accounting", async () => {
    const agent = makeAgent(
      [{ content: "looking", toolCalls: [{ name: "ping", args: {} }] }, { content: "done" }],
      [{ name: "ping", handler: async () => "pong" }],
    );
    await collect(agent.chatStream("hi"));
    const trace = agent.getLastTrace();
    expect(trace).toBeTruthy();
    const kinds = trace!.spans.map((s: any) => s.kind);
    expect(kinds).toContain("turn");
    expect(kinds).toContain("llm");
    expect(kinds).toContain("tool");

    const toolSpan = trace!.spans.find((s: any) => s.kind === "tool" && s.name === "ping")!;
    expect(toolSpan.status).toBe("ok");
    expect(toolSpan.endMs).not.toBeNull();

    const llmSpan = trace!.spans.find((s: any) => s.kind === "llm")!;
    expect(llmSpan.attrs.promptTokens).toBe(1);
    expect(llmSpan.attrs.completionTokens).toBe(1);

    // every span is closed once the turn ends
    expect(trace!.spans.every((s: any) => s.endMs !== null)).toBe(true);
  });
});

describe("agent · within-round dedup of read-only tools", () => {
  it("runs an idempotent tool once when the model emits it twice with identical args", async () => {
    let runs = 0;
    const agent = makeAgent(
      [{ content: "looking", toolCalls: [{ name: "rd", args: { p: "x" } }, { name: "rd", args: { p: "x" } }] }, { content: "done" }],
      [{ name: "rd", idempotent: true, handler: async () => { runs++; return "content-x"; } }],
    );
    const evs = await collect(agent.chatStream("go"));
    expect(runs).toBe(1); // deduped — handler ran once
    // both tool calls still get a result (the duplicate shares the original's)
    const done = evs.filter((e) => e.type === "tool_done" && e.tool_name === "rd");
    expect(done.length).toBe(2);
    expect(done.every((e) => e.success)).toBe(true);
  });

  it("does NOT dedup different args, nor non-idempotent tools", async () => {
    let rdRuns = 0, wrRuns = 0;
    const agent = makeAgent(
      [{ content: "x", toolCalls: [
        { name: "rd", args: { p: "a" } }, { name: "rd", args: { p: "b" } }, // different args → both run
        { name: "wr", args: { p: "a" } }, { name: "wr", args: { p: "a" } }, // not idempotent → both run
      ] }, { content: "done" }],
      [
        { name: "rd", idempotent: true, handler: async () => { rdRuns++; return "r"; } },
        { name: "wr", handler: async () => { wrRuns++; return "w"; } },
      ],
    );
    await collect(agent.chatStream("go"));
    expect(rdRuns).toBe(2);
    expect(wrRuns).toBe(2);
  });
});
