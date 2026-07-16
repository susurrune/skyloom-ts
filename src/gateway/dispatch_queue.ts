export interface GatewayDispatchQueueOptions {
  maxActive: number;
  maxPending: number;
  maxPendingPerKey: number;
  onError?: (error: unknown, key: string) => void;
}

interface DispatchJob {
  key: string;
  run: () => Promise<void>;
}

/** Bounded, fair queue that preserves ordering within each conversation. */
export class GatewayDispatchQueue {
  private readonly queues = new Map<string, DispatchJob[]>();
  private readonly readyKeys: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly activeKeys = new Set<string>();
  private readonly drainWaiters = new Set<() => void>();
  private active = 0;
  private pending = 0;
  private accepting = true;

  constructor(private readonly options: GatewayDispatchQueueOptions) {
    for (const [name, value] of Object.entries({
      maxActive: options.maxActive,
      maxPending: options.maxPending,
      maxPendingPerKey: options.maxPendingPerKey,
    })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
  }

  enqueue(key: string, run: () => Promise<void>): boolean {
    const normalizedKey = key.trim();
    if (!this.accepting || !normalizedKey || this.pending >= this.options.maxPending) return false;
    const queue = this.queues.get(normalizedKey) ?? [];
    if (queue.length >= this.options.maxPendingPerKey) return false;

    queue.push({ key: normalizedKey, run });
    this.queues.set(normalizedKey, queue);
    this.pending++;
    if (!this.activeKeys.has(normalizedKey)) this.markReady(normalizedKey);
    this.pump();
    return true;
  }

  stopAccepting(): void {
    this.accepting = false;
    this.notifyDrained();
  }

  stats(): { accepting: boolean; active: number; pending: number; conversations: number } {
    return {
      accepting: this.accepting,
      active: this.active,
      pending: this.pending,
      conversations: new Set([...this.activeKeys, ...this.queues.keys()]).size,
    };
  }

  async drain(): Promise<void> {
    if (this.active === 0 && this.pending === 0) return;
    await new Promise<void>((resolve) => { this.drainWaiters.add(resolve); });
  }

  private markReady(key: string): void {
    if (this.readySet.has(key)) return;
    this.readySet.add(key);
    this.readyKeys.push(key);
  }

  private pump(): void {
    while (this.active < this.options.maxActive && this.readyKeys.length > 0) {
      const key = this.readyKeys.shift()!;
      this.readySet.delete(key);
      if (this.activeKeys.has(key)) continue;
      const queue = this.queues.get(key);
      if (!queue) continue;
      const job = queue.shift();
      if (!job) {
        this.queues.delete(key);
        continue;
      }
      this.pending--;
      if (queue.length === 0) this.queues.delete(key);
      this.active++;
      this.activeKeys.add(key);
      void this.run(job);
    }
    this.notifyDrained();
  }

  private async run(job: DispatchJob): Promise<void> {
    try {
      await job.run();
    } catch (error) {
      try { this.options.onError?.(error, job.key); } catch { /* reporting must not break queue progress */ }
    } finally {
      this.active--;
      this.activeKeys.delete(job.key);
      if (this.queues.has(job.key)) this.markReady(job.key);
      this.pump();
    }
  }

  private notifyDrained(): void {
    if (this.active !== 0 || this.pending !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
