import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/core/agent/loop";
import { AgentState } from "../src/core/agent/task";
import { MessageBus } from "../src/core/bus";
import { ToolRegistry } from "../src/core/tool";
import { Tracer } from "../src/core/trace";

async function collect(stream: AsyncGenerator<Record<string, unknown>>) {
  const events: Record<string, unknown>[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("AgentLoop", () => {
  it("streams a simple response and persists the turn in order", async () => {
    const stored: Array<{ role: string; content: string }> = [];
    const states: AgentState[] = [];
    let extracted = 0;
    const memory = {
      shortTerm: stored,
      addMessage(role: string, content: string) {
        stored.push({ role, content });
      },
      pruneToolMessages() {},
    };
    const llm = {
      async *streamWithTools() {
        yield { type: "content", text: "云" };
        yield { type: "content", text: "开" };
        yield { type: "done", usage: { promptTokens: 2, completionTokens: 2 } };
      },
    };

    const loop = new AgentLoop({
      name: "fog",
      llm: llm as unknown as import("../src/core/llm").LLMClient,
      bus: new MessageBus(),
      memory: memory as unknown as import("../src/core/memory").Memory,
      toolRegistry: new ToolRegistry(),
      tracer: new Tracer(),
      getActiveSkills: () => new Set(),
      getSkills: () => [],
      activeToolNames: () => [],
      getSkillConfigOverrides: () => ({}),
      executeToolCalls: async () => [],
      setState: async (state) => { states.push(state); },
      maybeExtractFacts: () => { extracted++; },
      messagesWithRecall: async () => stored,
      popLastUserMessage: () => undefined,
      shouldAutoCompact: () => false,
      compact: async () => "",
      resolveModelId: () => "gpt-4o",
      getPlanMode: () => false,
      maxToolRoundsHardCap: 1000,
      maxNoProgressRounds: 6,
    });

    const events = await collect(loop.runStream("看看天空"));

    expect(events).toEqual([
      { type: "content", text: "云" },
      { type: "content", text: "开" },
      { type: "done" },
    ]);
    expect(stored).toEqual([
      { role: "user", content: "看看天空" },
      { role: "assistant", content: "云开" },
    ]);
    expect(states).toEqual([AgentState.THINKING, AgentState.IDLE]);
    expect(extracted).toBe(1);
  });
});
