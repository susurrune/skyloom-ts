/**
 * Channel gateway — runs the registered channel adapters behind one HTTP server
 * and bridges inbound platform messages to Skyloom agents.
 *
 *   platform → POST /webhook/<channel> → adapter.handleWebhook (verify+normalize)
 *            → route to agent → agent.chatStream → adapter.send (reply)
 *
 * The HTTP layer mirrors web/server.ts. Each channel handles its own signature
 * verification and URL-verification handshake inside handleWebhook, so the
 * gateway core never knows platform specifics. Agent replies are delivered
 * asynchronously (after the webhook is acked) because all three platforms
 * require a fast 200.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getLogger } from '../core/logger';
import { createSystemContext } from '../core/factory';
import { buildAdapters } from './registry';
import type { ChannelAdapter, InboundMessage, RawRequest } from './types';

const log = getLogger('gateway');

/** Collect the full request body. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Run an agent turn for an inbound message and collect the final text reply. */
async function runAgent(
  ctx: ReturnType<typeof createSystemContext>,
  adapter: ChannelAdapter,
  msg: InboundMessage,
): Promise<string> {
  const cfgChannels = (ctx.config as any).channels || {};
  const agentName = cfgChannels[adapter.id]?.agent || adapter.defaultAgent || 'fair';
  const agent = ctx.agentMap.get(agentName) || ctx.agentMap.get('fair') || [...ctx.agentMap.values()][0];
  if (!agent) throw new Error('no agent available');

  await agent.init();
  let text = '';
  try {
    for await (const ev of agent.chatStream(msg.text)) {
      if ((ev as any).type === 'content') text += (ev as any).text;
    }
  } catch (e) {
    log.warn('gateway_agent_failed', { channel: adapter.id, error: String(e) });
    return `[出错了] ${String(e)}`;
  }
  return text.trim() || '(无回复)';
}

export interface GatewayOptions {
  port?: number;
  host?: string;
}

export async function startGateway(opts: GatewayOptions = {}): Promise<void> {
  const ctx = createSystemContext();
  const adapters = buildAdapters((ctx.config as any).channels || {}, process.env);

  if (adapters.size === 0) {
    log.warn('gateway_no_channels', {});
    process.stdout.write(
      '\n  ⚠ 没有启用任何渠道。在 ~/.skyloom/config.yaml 配置 channels.feishu / channels.wecom / channels.qq,\n' +
      '    或设置对应环境变量(如 FEISHU_APP_ID/FEISHU_APP_SECRET)。\n\n',
    );
    return;
  }

  for (const adapter of adapters.values()) {
    if (adapter.start) {
      try { await adapter.start(); } catch (e) { log.warn('adapter_start_failed', { channel: adapter.id, error: String(e) }); }
    }
  }

  const port = opts.port ?? Number(process.env.SKYLOOM_GATEWAY_PORT) ?? 8848;
  // Gateways receive inbound webhooks from the platform's servers, so unlike the
  // local web UI they must bind to a reachable interface by default.
  const host = opts.host || process.env.SKYLOOM_GATEWAY_HOST || '0.0.0.0';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: true, channels: [...adapters.keys()] }));
        return;
      }
      const m = url.pathname.match(/^\/webhook\/([a-z0-9_-]+)$/i);
      if (!m) { res.writeHead(404).end('Not found'); return; }
      const adapter = adapters.get(m[1].toLowerCase());
      if (!adapter) { res.writeHead(404).end(`Unknown channel: ${m[1]}`); return; }

      const raw: RawRequest = {
        method: req.method || 'POST',
        headers: req.headers,
        query: url.searchParams,
        body: await readBody(req),
      };

      const outcome = await adapter.handleWebhook(raw);

      // Immediate HTTP response (challenge / ack / signature failure).
      if (outcome.response) {
        res.writeHead(outcome.response.status, {
          'Content-Type': outcome.response.contentType || 'text/plain; charset=utf-8',
        }).end(outcome.response.body ?? '');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      }

      // Route to an agent and deliver the reply asynchronously (after the ack).
      if (outcome.message) {
        const msg = outcome.message;
        void (async () => {
          try {
            const reply = await runAgent(ctx, adapter, msg);
            await adapter.send(msg.replyTo, reply);
          } catch (e) {
            log.warn('gateway_dispatch_failed', { channel: adapter.id, error: String(e) });
          }
        })();
      }
    } catch (e) {
      log.warn('gateway_request_error', { error: String(e) });
      if (!res.headersSent) res.writeHead(500).end('error');
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const list = [...adapters.values()].map((a) => `${a.name}(/webhook/${a.id})`).join(' · ');
      process.stdout.write(
        `\n  天空织机 · 渠道网关  ·  http://${host}:${port}\n  已启用: ${list}\n` +
        `  把对应平台的事件回调 URL 指向 http(s)://<你的域名>:${port}/webhook/<channel>\n\n`,
      );
      log.info('gateway_started', { port, host, channels: [...adapters.keys()] });
      resolve();
    });
  });

  const shutdown = async () => {
    for (const a of adapters.values()) { try { await a.stop?.(); } catch { /* ignore */ } }
    try { await ctx.closeAll(); } catch { /* ignore */ }
    server.close();
  };
  process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
}
