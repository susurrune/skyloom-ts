import { describe, it, expect, vi } from "vitest";
import { SystemContext, TaskExecutionResult } from "../src/core/factory";
import { MessageBus } from "../src/core/bus";

describe("factory · TaskExecutionResult", () => {
  it("holds the provided fields", () => {
    const r = new TaskExecutionResult({ id: "t1", agent: "fog", description: "do x", success: true, content: "done" });
    expect(r).toMatchObject({ id: "t1", agent: "fog", success: true, content: "done" });
  });
});

describe("factory · SystemContext", () => {
  function ctx(overrides: Partial<ConstructorParameters<typeof SystemContext>[0]> = {}) {
    return new SystemContext({
      config: { agents: {} } as any,
      bus: new MessageBus(),
      llm: {} as any,
      agentMap: new Map(),
      toolRegistry: {} as any,
      ...overrides,
    });
  }

  it("stores constructor options with sensible defaults", () => {
    const c = ctx({ workspacePath: "/ws" });
    expect(c.workspacePath).toBe("/ws");
    expect(c.mcp).toBeNull();
    expect(c.mcpStatus).toEqual([]);
    expect(c.agentMap.size).toBe(0);
  });

  it("initAll fires the plugin init hook before agents come up", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const c = ctx({ plugins: { emit } as any });
    await c.initAll();
    expect(emit).toHaveBeenCalledWith("init", expect.objectContaining({ config: expect.anything() }));
  });

  it("closeAll closes every agent and tolerates a missing mcp", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const agents = new Map<string, any>([
      ["fog", { close }],
      ["rain", { close }],
    ]);
    const c = ctx({ agentMap: agents as any });
    await c.closeAll();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("closeAll also closes mcp when present", async () => {
    const closeAll = vi.fn().mockResolvedValue(undefined);
    const c = ctx({ mcp: { closeAll } as any });
    await c.closeAll();
    expect(closeAll).toHaveBeenCalled();
  });
});
