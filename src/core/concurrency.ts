/**
 * Bounded-concurrency task runner with cooperative cancellation.
 *
 * Why this exists: the agent tool-execution loop previously fired every tool
 * call in a round at once via `Promise.all`. With Skyloom's now-large tool
 * surface, a single LLM round can request many parallel side-effecting tools
 * (http_request, download_file, port_check, file writes) — unbounded, that can
 * exhaust sockets, file descriptors, or CPU on the host. This caps how many run
 * at once while preserving result order.
 *
 * Cancellation is *cooperative*: JavaScript can't preempt a running promise, so
 * when the AbortSignal fires we stop *starting* queued tasks. In-flight tasks
 * are left to settle. The worker is told, per item, whether the signal had
 * already aborted when its turn came up, so the caller can short-circuit a
 * not-yet-started unit to a "cancelled" result instead of executing it.
 *
 * Pure and dependency-free → fully unit-testable.
 */

export interface BoundedOptions {
  /** Maximum tasks running at once. Values < 1 are clamped to 1. */
  concurrency: number;
  /** When aborted, queued (not-yet-started) tasks receive `aborted: true`. */
  signal?: AbortSignal;
}

/**
 * Map `items` through `worker` with at most `concurrency` running concurrently,
 * preserving input order in the returned array.
 *
 * `worker(item, index, aborted)` — `aborted` is the signal's state checked
 * immediately before this item is dispatched. A worker that respects it can
 * return a cancelled placeholder for queued items once the user interrupts.
 */
export async function mapBounded<T, R>(
  items: T[],
  worker: (item: T, index: number, aborted: boolean) => Promise<R>,
  opts: BoundedOptions,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;

  const limit = Math.max(1, Math.floor(opts.concurrency) || 1);
  let next = 0;

  const runner = async (): Promise<void> => {
    // Each runner pulls the next index until the queue drains. A shared cursor
    // (`next`) is safe here because there is no `await` between read and
    // increment — the single-threaded event loop makes `next++` atomic.
    while (true) {
      const i = next++;
      if (i >= n) return;
      const aborted = opts.signal?.aborted ?? false;
      results[i] = await worker(items[i], i, aborted);
    }
  };

  const runners = Array.from({ length: Math.min(limit, n) }, () => runner());
  await Promise.all(runners);
  return results;
}

/** Default parallel-tool cap when none is configured. Conservative but not serial. */
export const DEFAULT_TOOL_CONCURRENCY = 4;

/** Resolve a sane concurrency limit from a possibly-undefined config value. */
export function resolveConcurrency(raw: unknown, fallback = DEFAULT_TOOL_CONCURRENCY): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  // Cap the ceiling so a fat-fingered config can't reintroduce the unbounded blowup.
  return Math.min(Math.floor(n), 32);
}
