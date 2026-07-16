import { describe, expect, it } from "vitest";
import { runInSandbox } from "../src/core/sandbox";

describe("shell sandbox", () => {
  it("runs without blocking the event loop and stops on cancellation", async () => {
    const controller = new AbortController();
    const node = JSON.stringify(process.execPath);
    let eventLoopTicked = false;
    const tick = setTimeout(() => { eventLoopTicked = true; }, 20);
    const startedAt = Date.now();

    const pending = runInSandbox(`${node} -e "setInterval(() => {}, 1000)"`, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60);
    const result = await pending;
    clearTimeout(tick);

    expect(eventLoopTicked).toBe(true);
    expect(result.success).toBe(false);
    expect(result.killed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
