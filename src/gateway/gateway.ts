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
import { describeMedia, parseReply } from './types';
import { isSendableSrc } from './helpers';
import { describeImages } from './vision';
import type { ChannelAdapter, InboundMessage, RawRequest } from './types';
import type { LoadedMedia } from './helpers';

const log = getLogger('gateway');

/** Collect the full request body. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Run an agent turn for an inbound message and collect the final text reply. */
/** Build the agent prompt: text + media description + any vision result. */
function buildPrompt(msg: InboundMessage, canSendMedia: boolean, visionText?: string | null): string {
  const parts: string[] = [];
  const mediaDesc = describeMedia(msg.media);
  if (msg.text) parts.push(msg.text);
  if (mediaDesc) parts.push(`(用户发送了媒体: ${mediaDesc})`);
  if (visionText) parts.push(`(图片内容识别: ${visionText})`);
  if (canSendMedia) {
    parts.push('(若需回发图片或文件,在回复中用 Markdown 图片 ![说明](路径或URL) 或 [[file:路径或URL]] 表示,路径可为本地文件或 http(s) 链接。)');
  }
  return parts.join('\n\n') || msg.text;
}

/** Download inbound images and run vision over them. Returns null if disabled. */
async function visionForMessage(
  ctx: ReturnType<typeof createSystemContext>,
  adapter: ChannelAdapter,
  msg: InboundMessage,
): Promise<string | null> {
  const chCfg = ((ctx.config as any).channels || {})[adapter.id] || {};
  const llmCfg = (ctx.config as any).llm || {};
  if (chCfg.vision === false) return null;
  const model = chCfg.visionModel || llmCfg.vision_model || llmCfg.visionModel;
  if (!model) return null; // vision is opt-in: requires a configured model
  const images = (msg.media || []).filter((m) => m.kind === 'image');
  if (!images.length || !adapter.fetchMedia) return null;

  const loaded: LoadedMedia[] = [];
  for (const att of images.slice(0, 4)) {
    try {
      const got = await adapter.fetchMedia(att, msg);
      if (got) loaded.push({ data: got.data, filename: att.filename || 'image', contentType: got.contentType });
    } catch (e) {
      log.warn('vision_fetch_failed', { channel: adapter.id, error: String(e) });
    }
  }
  if (!loaded.length) return null;
  return describeImages(loaded, { model });
}

/** Resolve the agent for a channel message. */
function resolveAgent(ctx: ReturnType<typeof createSystemContext>, adapter: ChannelAdapter) {
  const cfgChannels = (ctx.config as any).channels || {};
  const agentName = cfgChannels[adapter.id]?.agent || adapter.defaultAgent || 'fair';
  return ctx.agentMap.get(agentName) || ctx.agentMap.get('fair') || [...ctx.agentMap.values()][0];
}

/** Dispatch one inbound message to its agent and deliver the reply. */
async function dispatch(
  ctx: ReturnType<typeof createSystemContext>,
  adapter: ChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const agent = resolveAgent(ctx, adapter);
  if (!agent) throw new Error('no agent available');
  await agent.init();
  const visionText = await visionForMessage(ctx, adapter, msg);
  const prompt = buildPrompt(msg, !!adapter.sendMedia, visionText);

  // Streaming path: stream content chunks straight to the adapter (e.g. a Feishu
  // card patched as text arrives). Falls back to collect-then-send otherwise.
  const cfgStreaming = ((ctx.config as any).channels || {})[adapter.id]?.streaming !== false;
  if (adapter.sendStreaming && cfgStreaming) {
    let full = '';
    async function* contentChunks(): AsyncGenerator<string> {
      try {
        for await (const ev of agent.chatStream(prompt)) {
          if ((ev as any).type === 'content') { const t = (ev as any).text as string; full += t; yield t; }
        }
      } catch (e) {
        log.warn('gateway_agent_failed', { channel: adapter.id, error: String(e) });
        yield `\n[出错了] ${String(e)}`;
      }
    }
    await adapter.sendStreaming(msg.replyTo, contentChunks());
    // After streaming the text, deliver any media the agent referenced.
    await deliverMedia(adapter, msg, full);
    return;
  }

  let text = '';
  try {
    for await (const ev of agent.chatStream(prompt)) {
      if ((ev as any).type === 'content') text += (ev as any).text;
    }
  } catch (e) {
    log.warn('gateway_agent_failed', { channel: adapter.id, error: String(e) });
    text = `[出错了] ${String(e)}`;
  }
  // Non-streaming: split out media so the text message is clean.
  if (adapter.sendMedia) {
    const parsed = parseReply(text);
    await adapter.send(msg.replyTo, parsed.text || '(无回复)');
    await deliverMedia(adapter, msg, text, parsed.media);
  } else {
    await adapter.send(msg.replyTo, text.trim() || '(无回复)');
  }
}

/** Upload+send any media the agent referenced in its reply. Best-effort. */
async function deliverMedia(
  adapter: ChannelAdapter,
  msg: InboundMessage,
  fullText: string,
  pre?: ReturnType<typeof parseReply>['media'],
): Promise<void> {
  if (!adapter.sendMedia) return;
  const media = pre ?? parseReply(fullText).media;
  for (const item of media) {
    if (!isSendableSrc(item.src)) {
      log.warn('gateway_media_unsendable', { channel: adapter.id, src: item.src });
      continue;
    }
    try {
      await adapter.sendMedia(msg.replyTo, item);
    } catch (e) {
      log.warn('gateway_send_media_failed', { channel: adapter.id, src: item.src, error: String(e) });
    }
  }
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
        void dispatch(ctx, adapter, msg).catch((e) =>
          log.warn('gateway_dispatch_failed', { channel: adapter.id, error: String(e) }));
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
