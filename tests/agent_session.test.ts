import { describe, expect, it } from "vitest";
import { AgentSessionController } from "../src/core/agent/session";
import { Tracer } from "../src/core/trace";

describe("AgentSessionController", () => {
  it("runs overlapping turns in FIFO order and releases the queue after failure", async () => {
    const order: string[] = [];
    const controller = new AgentSessionController({
      agentName: () => "fog",
      tracer: new Tracer(),
      getShortTerm: () => [],
      autoActivateSkills: () => [],
      popLastUserMessage: () => undefined,
    });

    const first = controller.withTurn(async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first:error");
      throw new Error("first failed");
    });
    const second = controller.withTurn(async () => {
      order.push("second:start");
      await Promise.resolve();
      order.push("second:end");
      return 2;
    });
    const third = controller.withTurn(async () => {
      order.push("third:start");
      order.push("third:end");
      return 3;
    });

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe(2);
    await expect(third).resolves.toBe(3);
    expect(order).toEqual([
      "first:start",
      "first:error",
      "second:start",
      "second:end",
      "third:start",
      "third:end",
    ]);
  });
});
