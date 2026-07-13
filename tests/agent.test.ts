import { describe, it, expect, vi } from "vitest";
import { FogAgent } from "../src/agents/fog";
import { RainAgent } from "../src/agents/rain";
import { Event, EventType, MessageBus } from "../src/core/bus";
import { ToolRegistry } from "../src/core/tool";
import { Skill, SkillRegistry } from "../src/core/skill";
import { Task, TaskResult } from "../src/core/agent/task";

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

function makeAgent(
  turns: Turn[],
  tools: { name: string; handler: (a: any) => Promise<string>; idempotent?: boolean }[] = [],
  bus: MessageBus = new MessageBus(),
) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register({ name: t.name, description: t.name, handler: t.handler, idempotent: t.idempotent });
  const config = { agents: { fog: {} }, llm: { language: "zh" }, memory: { shortTermLimit: 100, dbPath: "/tmp/sky-test" } };
  const agent = new FogAgent(config as any, new MockLLM(turns) as any, bus, reg, new SkillRegistry());
  return agent;
}

async function collect(gen: AsyncGenerator<any>, cap = 500): Promise<any[]> {
  const evs: any[] = [];
  for await (const ev of gen) { evs.push(ev); if (evs.length > cap) break; }
  return evs;
}

describe("agent · chat loop (mock LLM)", () => {
  it("allocates a distinct named memory store for each agent during base construction", () => {
    const config = { agents: { fog: {}, rain: {} }, llm: {}, memory: { shortTermLimit: 100, dbPath: "/tmp/sky-agent-memory/base.db" } };
    const bus = new MessageBus();
    const reg = new ToolRegistry();
    const skills = new SkillRegistry();
    const fog = new FogAgent(config as any, new MockLLM([]) as any, bus, reg, skills);
    const rain = new RainAgent(config as any, new MockLLM([]) as any, bus, reg, skills);

    expect((fog.memory as any).dbPath).toMatch(/[\\/]fog\.db$/);
    expect((rain.memory as any).dbPath).toMatch(/[\\/]rain\.db$/);
    expect((fog.memory as any).dbPath).not.toBe((rain.memory as any).dbPath);
  });

  it("initializes only once when repeated calls overlap", async () => {
    const bus = new MessageBus();
    const subscribe = vi.spyOn(bus, "subscribe");
    const agent = makeAgent([{ content: "ok" }], [], bus);

    await Promise.all([agent.init(), agent.init(), agent.init()]);

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("clears the delegation timeout as soon as a response arrives", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const bus = new MessageBus();
      const agent = makeAgent([], [], bus);
      await agent.init();

      const reply = agent.requestHelp("rain", "inspect this", 60);
      const timeoutHandle = setTimeoutSpy.mock.results.at(-1)?.value;
      expect(timeoutHandle).toBeDefined();
      await Promise.resolve();
      const request = bus.getHistory("fog").find((event) => event.type === EventType.AGENT_REQUEST);
      expect(request).toBeTruthy();

      await bus.publish(new Event(
        EventType.AGENT_RESPONSE,
        "rain",
        "fog",
        { correlation_id: request!.data.correlation_id, content: "done", success: true },
      ));

      await expect(reply).resolves.toBe("done");
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("settles a delegation with a fallback when the target times out", async () => {
    vi.useFakeTimers();
    try {
      const agent = makeAgent([]);
      const reply = agent.requestHelp("rain", "inspect this", 2);
      let result: string | undefined;
      void reply.then((value) => { result = value; });

      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();

      expect(result).toBe("[rain did not respond within 2s]");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an inbound delegation to finish before closing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent = makeAgent([]);
    vi.spyOn(agent, "executeTask").mockImplementation(async () => {
      await gate;
      return new TaskResult(true, "delegated result");
    });

    await agent.handleEvent(new Event(
      EventType.AGENT_REQUEST,
      "rain",
      "fog",
      { correlation_id: "close-123", description: "finish first", source: "rain" },
    ));

    let closed = false;
    const closing = agent.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    release();
    await closing;
    expect(closed).toBe(true);
  });

  it("routes a delegation response to the event source when payload source is absent", async () => {
    const bus = new MessageBus();
    const agent = makeAgent([], [], bus);
    vi.spyOn(agent, "executeTask").mockResolvedValue(new TaskResult(true, "private result"));

    await agent.handleEvent(new Event(
      EventType.AGENT_REQUEST,
      "rain",
      "fog",
      { correlation_id: "route-123", description: "inspect" },
    ));
    await agent.close();

    const response = bus.getHistory().find((event) => event.type === EventType.AGENT_RESPONSE);
    expect(response?.target).toBe("rain");
  });

  it("serializes overlapping streaming turns for the same agent", async () => {
    let active = 0;
    let maxActive = 0;
    const llm = {
      async *streamWithTools() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: "content", text: "ok" };
        active--;
        yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
      },
      async complete() { return { content: "ok", toolCalls: [], usage: {}, cost: 0, truncated: false }; },
      getTotalCost() { return 0; },
      getModel() { return "mock"; },
      setLogger() { /* noop */ },
    };
    const config = { agents: { fog: {} }, llm: {}, memory: { shortTermLimit: 100, dbPath: "/tmp/sky-test-stream-lock" } };
    const agent = new FogAgent(config as any, llm as any, new MessageBus(), new ToolRegistry(), new SkillRegistry());

    await Promise.all([
      collect(agent.chatStream("first")),
      collect(agent.chatStream("second")),
    ]);

    expect(maxActive).toBe(1);
  });

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

  it("keeps explicitly selected sessions isolated while streaming", async () => {
    const agent = makeAgent([{ content: "reply-one" }, { content: "reply-two" }]);
    await agent.init();
    const first = await agent.memory.createSession("first");
    const second = await agent.memory.createSession("second");

    await collect((agent as any).chatStreamInSession(first, "message-one"));
    await collect((agent as any).chatStreamInSession(second, "message-two"));

    await agent.memory.loadSession(first);
    expect(agent.memory.getMessages().filter((m) => m.role !== "system").map((m) => m.content))
      .toEqual(["message-one", "reply-one"]);
    await agent.memory.loadSession(second);
    expect(agent.memory.getMessages().filter((m) => m.role !== "system").map((m) => m.content))
      .toEqual(["message-two", "reply-two"]);
  });

  it("does not mutate current history when a requested session is missing", async () => {
    const agent = makeAgent([{ content: "unused" }]);
    await agent.init();
    const existing = await agent.memory.createSession("existing");
    agent.memory.addMessage("user", "keep-me");

    await expect(collect((agent as any).chatStreamInSession("missing-session", "new-message")))
      .rejects.toThrow("session not found");

    expect(agent.memory.getActiveSession()).toBe(existing);
    expect(agent.memory.getMessages().map((m) => m.content)).toContain("keep-me");
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
    const status = evs.find((e) => e.type === "tool_status" && e.tool_name === "echo");
    const done = evs.find((e) => e.type === "tool_done" && e.tool_name === "echo" && e.success);
    expect(status).toBeTruthy();
    expect(done).toBeTruthy();
    expect(status.tool_call_id).toMatch(/^call_/);
    expect(done.tool_call_id).toBe(status.tool_call_id);
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

describe("agent · skill routing", () => {
  function makeSkilledAgent(skills: Skill[]) {
    const registry = new SkillRegistry();
    for (const skill of skills) registry.register(skill);
    const config = {
      agents: { fog: {} },
      llm: { language: "zh" },
      memory: { shortTermLimit: 100, dbPath: `/tmp/sky-skill-${Date.now()}-${Math.random()}.db` },
    };
    return new FogAgent(
      config as any,
      new MockLLM([{ content: "ok" }]) as any,
      new MessageBus(),
      new ToolRegistry(),
      registry,
    );
  }

  it("prioritizes the current agent's skills and limits automatic activation", async () => {
    const agent = makeSkilledAgent([
      new Skill({ name: "generic_one", description: "generic", triggers: ["创建"] }),
      new Skill({ name: "code_analysis", description: "analysis", triggers: ["创建"] }),
      new Skill({ name: "web_research", description: "research", triggers: ["创建"] }),
      new Skill({ name: "generic_two", description: "generic", triggers: ["创建"] }),
    ]);
    await agent.init();

    const activated = (agent as any).autoActivateSkills("请创建一个方案");

    expect(activated).toEqual(["web_research", "code_analysis"]);
    expect(agent.getActiveSkills().sort()).toEqual(["code_analysis", "web_research"]);
  });

  it("replaces skills selected automatically for the previous turn", async () => {
    const agent = makeSkilledAgent([
      new Skill({ name: "web_research", description: "research", triggers: ["搜索"] }),
      new Skill({ name: "code_analysis", description: "analysis", triggers: ["分析"] }),
    ]);
    await agent.init();

    expect((agent as any).autoActivateSkills("请搜索资料")).toEqual(["web_research"]);
    expect((agent as any).autoActivateSkills("现在分析代码")).toEqual(["code_analysis"]);
    expect(agent.getActiveSkills()).toEqual(["code_analysis"]);
  });

  it("keeps manually activated skills pinned across turns", async () => {
    const agent = makeSkilledAgent([
      new Skill({ name: "web_research", description: "research", triggers: ["搜索"] }),
      new Skill({ name: "code_analysis", description: "analysis", triggers: ["分析"] }),
    ]);
    await agent.init();
    expect(agent.activateSkill("web_research")).toBe(true);

    expect((agent as any).autoActivateSkills("现在分析代码")).toEqual(["code_analysis"]);
    expect(agent.getActiveSkills().sort()).toEqual(["code_analysis", "web_research"]);
    expect((agent as any).autoActivateSkills("普通对话")).toEqual([]);
    expect(agent.getActiveSkills()).toEqual(["web_research"]);
  });

  it("does not match short latin triggers inside unrelated words", async () => {
    const agent = makeSkilledAgent([
      new Skill({ name: "ci_cd_manager", description: "CI", triggers: ["ci"] }),
    ]);
    await agent.init();

    expect((agent as any).autoActivateSkills("Discuss social impact")).toEqual([]);
  });

  it("lists recommended skills before general capabilities", async () => {
    const agent = makeSkilledAgent([
      new Skill({ name: "generic", description: "generic" }),
      new Skill({ name: "web_research", description: "research" }),
      new Skill({ name: "code_analysis", description: "analysis" }),
    ]);
    await agent.init();

    expect(agent.getAvailableSkills()).toEqual([
      { name: "web_research", description: "research", active: false, recommended: true },
      { name: "code_analysis", description: "analysis", active: false, recommended: true },
      { name: "generic", description: "generic", active: false, recommended: false },
    ]);
  });

  it("auto-selects skills for blocking chat as well as streaming chat", async () => {
    const agent = makeSkilledAgent([
      new Skill({ name: "web_research", description: "research", triggers: ["搜索"] }),
    ]);

    await agent.chat("请搜索资料");

    expect(agent.getActiveSkills()).toEqual(["web_research"]);
  });
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

describe("agent · progress-based stopping", () => {
  function budgetAgent(llmCfg: any, turns: Turn[] = [{ content: "x" }], tools: any[] = []) {
    const reg = new ToolRegistry();
    for (const t of tools) reg.register({ name: t.name, description: t.name, handler: t.handler, maxRetries: 0 });
    const config = { agents: { fog: {} }, llm: llmCfg, memory: { shortTermLimit: 200, dbPath: "/tmp/sky-test" } };
    return new FogAgent(config as any, new MockLLM(turns) as any, new MessageBus(), reg, new SkillRegistry());
  }

  it("defaults: generous backstop + small no-progress threshold", () => {
    const a = budgetAgent({}) as any;
    expect(a._maxToolRoundsHardCap).toBe(1000);
    expect(a._maxNoProgressRounds).toBe(6);
  });

  it("honors config overrides for hard cap and no-progress rounds", () => {
    const a = budgetAgent({ max_tool_rounds_hard_cap: 30, max_no_progress_rounds: 3 }) as any;
    expect(a._maxToolRoundsHardCap).toBe(30);
    expect(a._maxNoProgressRounds).toBe(3);
  });

  it("max_tool_rounds_hard_cap: 0 means effectively unlimited", () => {
    const a = budgetAgent({ max_tool_rounds_hard_cap: 0 }) as any;
    expect(a._maxToolRoundsHardCap).toBeGreaterThanOrEqual(1000000);
  });

  it("a long PRODUCTIVE run is never cut off by a round count", async () => {
    // 60 rounds that each make genuine progress (a DISTINCT successful tool
    // call — not a repeated signature), then finish. With the old round caps
    // (40) this died; progress-based stopping lets it run to completion.
    let n = 0;
    const turns: Turn[] = [
      ...Array.from({ length: 60 }, (_v, i) => ({ toolCalls: [{ name: "step", args: { i } }] })),
      { content: "done after 60 productive rounds" },
    ];
    const a = budgetAgent({}, turns, [{ name: "step", handler: async () => `progress ${++n}` }]);
    const evs = await collect(a.chatStream("do a big task"), 5000);
    const text = evs.filter((e) => e.type === "content").map((e) => e.text).join("");
    expect(text).toContain("done after 60 productive rounds");
    expect(evs.some((e) => e.type === "truncated")).toBe(false);
  }, 20000);

  it("stops on no-progress: distinct tool calls that all fail, never any text", async () => {
    // Each round calls a DIFFERENT failing tool with no text. The LoopGuard's
    // signature/stuck heuristics may not trip (calls differ), so the
    // progress breaker is what must stop the spin. Distinct args avoid the
    // signature-loop path; the tool always fails so no round makes progress.
    const turns: Turn[] = Array.from({ length: 40 }, (_v, i) => ({ toolCalls: [{ name: "flaky", args: { i } }] }));
    const a = budgetAgent({ max_no_progress_rounds: 5 }, turns, [
      { name: "flaky", handler: async () => { throw new Error("nope"); } },
    ]) as any;
    const evs = await collect(a.chatStream("spin"), 500);
    expect(evs.some((e) => e.type === "done")).toBe(true);
    const text = evs.filter((e) => e.type === "content").map((e: any) => e.text).join("");
    expect(text).toMatch(/stalled|stuck/); // stopped by a breaker, not 40 rounds
  }, 15000);
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

  it("creates a closed trace for non-streaming orchestration tasks", async () => {
    const agent = makeAgent([{ content: "actual task deliverable" }]);
    const task = new Task({
      id: "task-1",
      description: "produce a deliverable",
      assignedTo: "fog",
      metadata: { runId: "run-1", attempt: 1 },
    });
    const outcome = await agent.executeTask(task);
    const trace = agent.getLastTrace();

    expect(outcome.success).toBe(true);
    expect(trace?.label).toContain("[task]");
    expect(trace?.spans.some(span => span.kind === "llm")).toBe(true);
    expect(trace?.spans.every(span => span.endMs !== null)).toBe(true);
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
