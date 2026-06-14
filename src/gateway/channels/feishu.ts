/**
 * Feishu / Lark channel adapter.
 *
 * Inbound: the event-subscription webhook (v2 schema). Handles the
 * url_verification challenge, optional AES-encrypted payloads, and the optional
 * verification-token check, then normalizes im.message.receive_v1 events.
 *
 * Outbound: obtains a tenant_access_token (cached) and replies via the
 * im/v1/messages API (text by default).
 *
 * Config (channels.feishu): { appId, appSecret, encryptKey?, verificationToken?,
 *   domain?: 'feishu'|'lark', agent? }. Env fallback: FEISHU_APP_ID,
 *   FEISHU_APP_SECRET, FEISHU_ENCRYPT_KEY, FEISHU_VERIFICATION_TOKEN.
 */

import * as crypto from 'crypto';
import { getLogger } from '../../core/logger';
import { resolveSecret, postJson, postMultipart, loadMedia, TokenCache } from '../helpers';
import type { ChannelAdapter, MediaAttachment, OutboundMedia, RawRequest, ReplyTarget, WebhookOutcome } from '../types';

const log = getLogger('channel-feishu');

/** Decrypt a Feishu AES-256-CBC encrypted event body. */
export function decryptFeishu(encrypt: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const data = Buffer.from(encrypt, 'base64');
  const iv = data.subarray(0, 16);
  const ciphertext = data.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // PKCS#7 unpad
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  return out.toString('utf8');
}

export function createFeishuAdapter(cfg: any, env: NodeJS.ProcessEnv): ChannelAdapter | null {
  const appId = resolveSecret(cfg.appId, env, 'FEISHU_APP_ID');
  const appSecret = resolveSecret(cfg.appSecret, env, 'FEISHU_APP_SECRET');
  if (!appId || !appSecret) return null; // not configured

  const encryptKey = resolveSecret(cfg.encryptKey, env, 'FEISHU_ENCRYPT_KEY');
  const verificationToken = resolveSecret(cfg.verificationToken, env, 'FEISHU_VERIFICATION_TOKEN');
  const base = cfg.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  // 'card' replies render as an interactive card (supports streaming patches);
  // 'raw' forces plain text; 'auto' (default) uses a card so streaming works.
  const renderMode: 'auto' | 'raw' | 'card' = cfg.renderMode || 'auto';
  const useCard = renderMode === 'card' || renderMode === 'auto';

  const tokenCache = new TokenCache(async () => {
    const data = await postJson(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: appId, app_secret: appSecret,
    });
    if (data.code !== 0) throw new Error(`feishu token error ${data.code}: ${data.msg}`);
    return { token: data.tenant_access_token, expiresInSec: data.expire ?? 7200 };
  });

  const authHeader = async () => ({ Authorization: `Bearer ${await tokenCache.get()}` });
  const onTokenError = (code: number) => { if (code === 99991663 || code === 99991661) tokenCache.invalidate(); };

  /** A minimal interactive card carrying a single markdown body. */
  const cardContent = (text: string): string => JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    elements: [{ tag: 'markdown', content: text || ' ' }],
  });

  /** Create a card message in a chat; returns its message_id for later patches. */
  const createCard = async (chatId: string, text: string): Promise<string | null> => {
    const data = await postJson(
      `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      { receive_id: chatId, msg_type: 'interactive', content: cardContent(text) },
      { headers: await authHeader() },
    );
    if (data.code !== 0) { onTokenError(data.code); throw new Error(`feishu card create ${data.code}: ${data.msg}`); }
    return data.data?.message_id || null;
  };

  /** Patch an existing card message with new content. */
  const patchCard = async (messageId: string, text: string): Promise<void> => {
    const data = await postJson(
      `${base}/open-apis/im/v1/messages/${messageId}`,
      { content: cardContent(text) },
      { headers: await authHeader() },
    ).catch((e) => ({ code: -1, msg: String(e) }));
    if (data && data.code !== 0) onTokenError(data.code);
  };

  // De-dupe redelivered events (Feishu retries on slow ack).
  const seen = new Set<string>();
  const remember = (id: string): boolean => {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 2000) seen.clear();
    return false;
  };

  return {
    id: 'feishu',
    name: 'Feishu/Lark',
    defaultAgent: cfg.agent || 'fair',

    async handleWebhook(req: RawRequest): Promise<WebhookOutcome> {
      let payload: any;
      try { payload = JSON.parse(req.body.toString('utf8') || '{}'); } catch { return { response: { status: 400, body: 'bad json' } }; }

      // Encrypted transport: { encrypt: "..." } → decrypt to the real payload.
      if (payload.encrypt) {
        if (!encryptKey) return { response: { status: 400, body: 'encrypt key not configured' } };
        try { payload = JSON.parse(decryptFeishu(payload.encrypt, encryptKey)); }
        catch (e) { log.warn('feishu_decrypt_failed', { error: String(e) }); return { response: { status: 400, body: 'decrypt failed' } }; }
      }

      // URL verification handshake.
      if (payload.type === 'url_verification') {
        if (verificationToken && payload.token && payload.token !== verificationToken) {
          return { response: { status: 403, body: 'bad token' } };
        }
        return { response: { status: 200, contentType: 'application/json', body: JSON.stringify({ challenge: payload.challenge }) } };
      }

      // Verification token check (v2 puts it in header.token).
      const token = payload.header?.token ?? payload.token;
      if (verificationToken && token && token !== verificationToken) {
        return { response: { status: 403, body: 'bad token' } };
      }

      const eventId = payload.header?.event_id;
      if (remember(eventId)) return {}; // duplicate redelivery

      const eventType = payload.header?.event_type ?? payload.event?.type;
      if (eventType !== 'im.message.receive_v1') return {}; // only handle message receipts

      const message = payload.event?.message;
      if (!message) return {};
      const chatId = message.chat_id as string;
      const msgType = message.message_type as string;
      let text = '';
      const media: MediaAttachment[] = [];
      let content: any = {};
      try { content = JSON.parse(message.content || '{}'); } catch { /* ignore */ }
      switch (msgType) {
        case 'text':
          text = (content.text || '').replace(/@_user_\d+/g, '').trim(); // strip @mentions
          break;
        case 'image':
          media.push({ kind: 'image', ref: content.image_key });
          break;
        case 'audio':
          media.push({ kind: 'audio', ref: content.file_key });
          break;
        case 'media': // short video
          media.push({ kind: 'video', ref: content.file_key, filename: content.file_name });
          break;
        case 'file':
          media.push({ kind: 'file', ref: content.file_key, filename: content.file_name });
          break;
        case 'sticker':
          media.push({ kind: 'sticker', ref: content.file_key });
          break;
        case 'post': { // rich text: pull plain text + embedded images
          const blocks = content?.content;
          if (Array.isArray(blocks)) {
            for (const row of blocks) {
              for (const el of row || []) {
                if (el?.tag === 'text' && el.text) text += el.text;
                else if (el?.tag === 'a' && el.text) text += el.text;
                else if (el?.tag === 'img' && el.image_key) media.push({ kind: 'image', ref: el.image_key });
              }
              text += '\n';
            }
          }
          text = text.trim();
          break;
        }
        default:
          text = `[${msgType} 消息]`;
      }
      const senderId = payload.event?.sender?.sender_id?.open_id || payload.event?.sender?.sender_id?.user_id || 'unknown';

      return {
        message: {
          channel: 'feishu',
          conversationId: chatId || senderId,
          userId: senderId,
          text,
          media: media.length ? media : undefined,
          replyTo: { channel: 'feishu', chatId },
          raw: payload,
        },
      };
    },

    async send(target: ReplyTarget, text: string): Promise<void> {
      const chatId = target.chatId as string;
      if (!chatId) return;
      if (useCard) { await createCard(chatId, text); return; }
      const data = await postJson(
        `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        { headers: await authHeader() },
      );
      if (data.code !== 0) { onTokenError(data.code); throw new Error(`feishu send error ${data.code}: ${data.msg}`); }
    },

    // Streaming reply: post a placeholder card, then patch it as text arrives —
    // throttled (≥600ms apart) to stay well under Feishu's update rate limit.
    async sendStreaming(target: ReplyTarget, chunks: AsyncIterable<string>): Promise<void> {
      const chatId = target.chatId as string;
      if (!chatId) return;
      if (!useCard) { // plain-text mode can't patch; collect then send once
        let all = '';
        for await (const c of chunks) all += c;
        await this.send(target, all.trim() || '(无回复)');
        return;
      }
      let messageId: string | null = null;
      let acc = '';
      let lastPatch = 0;
      let dirty = false;
      const MIN_INTERVAL = 600;
      try {
        messageId = await createCard(chatId, '思考中…');
      } catch (e) { log.warn('feishu_card_create_failed', { error: String(e) }); return; }
      if (!messageId) return;

      for await (const chunk of chunks) {
        acc += chunk;
        dirty = true;
        const now = Date.now();
        if (now - lastPatch >= MIN_INTERVAL) {
          lastPatch = now;
          dirty = false;
          await patchCard(messageId, acc);
        }
      }
      // Final flush so the last tokens always land.
      if (dirty || acc) await patchCard(messageId, acc.trim() || '(无回复)');
    },

    async sendMedia(target: ReplyTarget, item: OutboundMedia): Promise<void> {
      const chatId = target.chatId as string;
      if (!chatId) return;
      const loaded = await loadMedia(item.src);
      const headers = await authHeader();

      if (item.kind === 'image') {
        const up = await postMultipart(`${base}/open-apis/im/v1/images`, {
          image_type: 'message',
          image: { data: loaded.data, filename: loaded.filename || 'image', contentType: loaded.contentType || 'image/png' },
        }, { headers });
        if (up.code !== 0) { onTokenError(up.code); throw new Error(`feishu image upload ${up.code}: ${up.msg}`); }
        const imageKey = up.data?.image_key;
        const send = await postJson(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
          { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
          { headers });
        if (send.code !== 0) { onTokenError(send.code); throw new Error(`feishu image send ${send.code}: ${send.msg}`); }
        return;
      }

      // file: upload to im/v1/files then send a file message
      const up = await postMultipart(`${base}/open-apis/im/v1/files`, {
        file_type: 'stream',
        file_name: loaded.filename || 'file',
        file: { data: loaded.data, filename: loaded.filename || 'file', contentType: loaded.contentType || 'application/octet-stream' },
      }, { headers });
      if (up.code !== 0) { onTokenError(up.code); throw new Error(`feishu file upload ${up.code}: ${up.msg}`); }
      const fileKey = up.data?.file_key;
      const send = await postJson(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
        { headers });
      if (send.code !== 0) { onTokenError(send.code); throw new Error(`feishu file send ${send.code}: ${send.msg}`); }
    },
  };
}
