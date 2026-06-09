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

function makeAgent(turns: Turn[], tools: { name: string; handler: (a: any) => Promise<string> }[] = []) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register({ name: t.name, description: t.name, handler: t.handler });
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
