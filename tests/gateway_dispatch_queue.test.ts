import { describe, expect, it, vi } from 'vitest';
import { GatewayDispatchQueue } from '../src/gateway/dispatch_queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('GatewayDispatchQueue', () => {
  it('bounds active and pending work', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const queue = new GatewayDispatchQueue({ maxActive: 2, maxPending: 1, maxPendingPerKey: 1 });
    const job = (index: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await gates[index].promise;
      active--;
    };

    expect(queue.enqueue('a', job(0))).toBe(true);
    expect(queue.enqueue('b', job(1))).toBe(true);
    expect(queue.enqueue('c', job(2))).toBe(true);
    expect(queue.enqueue('d', vi.fn(async () => undefined))).toBe(false);
    expect(queue.stats()).toEqual({ accepting: true, active: 2, pending: 1, conversations: 3 });

    gates[0].resolve();
    gates[1].resolve();
    gates[2].resolve();
    await queue.drain();
    expect(peak).toBe(2);
    expect(queue.stats()).toEqual({ accepting: true, active: 0, pending: 0, conversations: 0 });
  });

  it('keeps each conversation ordered while rotating fairly between conversations', async () => {
    const order: string[] = [];
    const first = deferred();
    const queue = new GatewayDispatchQueue({ maxActive: 1, maxPending: 10, maxPendingPerKey: 4 });

    queue.enqueue('a', async () => { order.push('a1'); await first.promise; });
    queue.enqueue('a', async () => { order.push('a2'); });
    queue.enqueue('b', async () => { order.push('b1'); });
    first.resolve();

    await queue.drain();
    expect(order).toEqual(['a1', 'b1', 'a2']);
  });

  it('rejects excess work for one conversation and stops accepting before drain', async () => {
    const gate = deferred();
    const queue = new GatewayDispatchQueue({ maxActive: 1, maxPending: 4, maxPendingPerKey: 1 });

    expect(queue.enqueue('a', async () => { await gate.promise; })).toBe(true);
    expect(queue.enqueue('a', async () => undefined)).toBe(true);
    expect(queue.enqueue('a', async () => undefined)).toBe(false);
    queue.stopAccepting();
    expect(queue.enqueue('b', async () => undefined)).toBe(false);

    gate.resolve();
    await queue.drain();
    expect(queue.stats().accepting).toBe(false);
  });
});
