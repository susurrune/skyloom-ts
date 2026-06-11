import { describe, it, expect } from "vitest";
import { mapBounded, resolveConcurrency, DEFAULT_TOOL_CONCURRENCY } from "../src/core/concurrency";

/** A deferred promise we can resolve by hand to control scheduling. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("mapBounded", () => {
  it("preserves input order regardless of completion order", async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await mapBounded(
      delays,
      (d, i) => new Promise<number>((r) => setTimeout(() => r(i), d)),
      { concurrency: 5 },
    );
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapBounded(
      items,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
  });

  it("returns an empty array for empty input without invoking the worker", async () => {
    let called = false;
    const out = await mapBounded([], async () => { called = true; return 1; }, { concurrency: 4 });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("clamps concurrency below 1 up to a single serial runner", async () => {
    let active = 0;
    let peak = 0;
    await mapBounded(
      [1, 2, 3, 4],
      async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; },
      { concurrency: 0 },
    );
    expect(peak).toBe(1);
  });

  it("tells the worker when the signal aborted before a task started", async () => {
    const ac = new AbortController();
    const gate = deferred<void>();
    const seen: boolean[] = [];

    // concurrency 1 → strictly serial, so we can abort between items.
    const run = mapBounded(
      [0, 1, 2, 3],
      async (_item, i, aborted) => {
        seen[i] = aborted;
        if (i === 0) await gate.promise; // hold the first task open
        return aborted;
      },
      { concurrency: 1, signal: ac.signal },
    );

    // Abort while task 0 is parked, then let it finish.
    ac.abort();
    gate.resolve();
    const out = await run;

    // Task 0 started before the abort; 1..3 were dispatched after → aborted.
    expect(seen[0]).toBe(false);
    expect(seen[1]).toBe(true);
    expect(seen[2]).toBe(true);
    expect(seen[3]).toBe(true);
    expect(out).toEqual([false, true, true, true]);
  });
});

describe("resolveConcurrency", () => {
  it("falls back to the default for missing/invalid values", () => {
    expect(resolveConcurrency(undefined)).toBe(DEFAULT_TOOL_CONCURRENCY);
    expect(resolveConcurrency(null)).toBe(DEFAULT_TOOL_CONCURRENCY);
    expect(resolveConcurrency("nope")).toBe(DEFAULT_TOOL_CONCURRENCY);
    expect(resolveConcurrency(0)).toBe(DEFAULT_TOOL_CONCURRENCY);
    expect(resolveConcurrency(-3)).toBe(DEFAULT_TOOL_CONCURRENCY);
  });

  it("honors a valid configured value and caps the ceiling", () => {
    expect(resolveConcurrency(1)).toBe(1);
    expect(resolveConcurrency(8)).toBe(8);
    expect(resolveConcurrency("6")).toBe(6);
    expect(resolveConcurrency(1000)).toBe(32);
  });
});
