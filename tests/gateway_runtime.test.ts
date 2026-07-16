import { describe, expect, it, vi } from 'vitest';
import { startGateway } from '../src/gateway/gateway';
import type { ChannelAdapter, InboundMessage } from '../src/gateway/types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('gateway runtime', () => {
  it('acks before dispatch, reports pressure, rejects overflow, and drains before shutdown', async () => {
    const gate = deferred();
    const lifecycle: string[] = [];
    const send = vi.fn(async (_target, text: string) => { lifecycle.push(`send:${text}`); });
    const message: InboundMessage = {
      channel: 'test',
      conversationId: 'conversation-1',
      userId: 'user-1',
      text: 'hello',
      replyTo: { channel: 'test' },
    };
    const adapter: ChannelAdapter = {
      id: 'test',
      name: 'Test',
      defaultAgent: 'fair',
      handleWebhook: vi.fn(async () => ({ message })),
      send,
      stop: vi.fn(async () => { lifecycle.push('adapter.stop'); }),
    };
    const agent = {
      init: vi.fn(async () => undefined),
      chatStreamInNamedSession: vi.fn(async function* () {
        await gate.promise;
        yield { type: 'content', text: 'reply' };
      }),
    };
    const context = {
      config: { channels: {} },
      agentMap: new Map([['fair', agent]]),
      closeAll: vi.fn(async () => { lifecycle.push('context.close'); }),
    };
    const port = 18984;
    const runtime = await startGateway(
      { port, host: '127.0.0.1', maxActiveDispatches: 1, maxPendingDispatches: 1, maxPendingPerConversation: 1 },
      context as any,
      new Map([['test', adapter]]),
    );
    expect(runtime).toBeDefined();

    const webhook = () => fetch(`http://127.0.0.1:${port}/webhook/test`, { method: 'POST', body: '{}' });
    try {
      await expect(webhook()).resolves.toMatchObject({ status: 200 });
      await expect(webhook()).resolves.toMatchObject({ status: 200 });
      await expect(webhook()).resolves.toMatchObject({ status: 200 });

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(message.replyTo, '当前消息较多，请稍后再试。');
      });
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        channels: ['test'],
        dispatch: { accepting: true, active: 1, pending: 1, conversations: 1 },
      });

      let closed = false;
      const closing = runtime!.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      expect(adapter.stop).not.toHaveBeenCalled();

      gate.resolve();
      await closing;
      expect(agent.chatStreamInNamedSession).toHaveBeenCalledTimes(2);
      expect(lifecycle.slice(-2)).toEqual(['adapter.stop', 'context.close']);
    } finally {
      gate.resolve();
      await runtime?.close();
    }
  });
});
