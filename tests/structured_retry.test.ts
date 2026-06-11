import { describe, it, expect } from "vitest";
import { parseWithRetry, SchemaValidationError } from "../src/core/schemas";
import { SnowAgent } from "../src/agents/snow";
import { MessageBus } from "../src/core/bus";
import { ToolRegistry } from "../src/core/tool";
import { SkillRegistry } from "../src/core/skill";

describe("parseWithRetry", () => {
  it("returns the first valid parse without retrying", async () => {
    let asks = 0;
    const v = await parseWithRetry(
      async () => { asks++; return '{"ok":1}'; },
      (raw) => JSON.parse(raw),
    );
    expect(v).toEqual({ ok: 1 });
    expect(asks).toBe(1);
  });

  it("feeds the parse error back and succeeds on a later attempt", async () => {
    const replies = ["not json", "still bad", '{"ok":1}'];
    const errors: string[] = [];
    let lastPrior: string | null = "sentinel";
    const v = await parseWithRetry(
      async (priorError, attempt) => { lastPrior = priorError; return replies[attempt]; },
      (raw) => { const d = JSON.parse(raw); return d; },
      { retries: 2, onRetry: (_a, e) => errors.push(e) },
    );
    expect(v).toEqual({ ok: 1 });
    expect(errors).toHaveLength(2);     // two failures before success
    expect(lastPrior).not.toBeNull();   // third attempt received the prior error
  });

  it("throws after exhausting retries", async () => {
    await expect(parseWithRetry(
      async () => "nope",
      (raw) => JSON.parse(raw),
      { retries: 1 },
    )).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

/** Mock LLM that yields scripted contents across successive llmLoop calls. */
class ScriptedLLM {
  calls = 0;
  constructor(private contents: string[]) {}
  async *streamWithTools(): AsyncGenerator<any> {
    const c = this.contents[Math.min(this.calls, this.contents.length - 1)];
    this.calls++;
    yield { type: "content", text: c };
    yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
  }
  async complete(): Promise<any> {
    const c = this.contents[Math.min(this.calls, this.contents.length - 1)];
    this.calls++;
    return { content: c, toolCalls: [], model: "mock", usage: { promptTokens: 1, completionTokens: 1 }, cost: 0, truncated: false };
  }
  getTotalCost() { return 0; }
  getModel() { return "mock"; }
  setLogger() { /* noop */ }
}

function makeSnow(contents: string[]) {
  const config = { agents: { snow: {} }, llm: { language: "zh" }, memory: { shortTermLimit: 100, dbPath: "/tmp/sky-test-snow" } };
  return new SnowAgent(config as any, new ScriptedLLM(contents) as any, new MessageBus(), new ToolRegistry(), new SkillRegistry());
}

describe("snow.orchestrate · structured-output retry", () => {
  const goodPlan = JSON.stringify({ goal: "g", steps: [
    { id: "1", description: "research", agent: "fog" },
    { id: "2", description: "code", agent: "rain" },
  ]});

  it("recovers a multi-step plan after a malformed first response", async () => {
    const snow = makeSnow(["这是我的计划：不是 JSON", goodPlan]);
    const tasks = await snow.orchestrate("build X");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.assignedTo)).toEqual(["fog", "rain"]);
  });

  it("falls back to a single task only after all retries fail", async () => {
    const snow = makeSnow(["garbage", "still garbage", "nope not json either", "and again"]);
    const tasks = await snow.orchestrate("build Y");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedTo).toBe("rain");
    expect(tasks[0].description).toBe("build Y");
  });
});
