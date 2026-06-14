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
import { resolveSecret, postJson, TokenCache } from '../helpers';
import type { ChannelAdapter, RawRequest, ReplyTarget, WebhookOutcome } from '../types';

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

  const tokenCache = new TokenCache(async () => {
    const data = await postJson(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: appId, app_secret: appSecret,
    });
    if (data.code !== 0) throw new Error(`feishu token error ${data.code}: ${data.msg}`);
    return { token: data.tenant_access_token, expiresInSec: data.expire ?? 7200 };
  });

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
      if (msgType === 'text') {
        try { text = JSON.parse(message.content || '{}').text || ''; } catch { text = ''; }
        // Strip @mentions like "@_user_1 ".
        text = text.replace(/@_user_\d+/g, '').trim();
      } else {
        text = `[${msgType} 消息]`;
      }
      const senderId = payload.event?.sender?.sender_id?.open_id || payload.event?.sender?.sender_id?.user_id || 'unknown';

      return {
        message: {
          channel: 'feishu',
          conversationId: chatId || senderId,
          userId: senderId,
          text,
          replyTo: { channel: 'feishu', chatId },
          raw: payload,
        },
      };
    },

    async send(target: ReplyTarget, text: string): Promise<void> {
      const chatId = target.chatId as string;
      if (!chatId) return;
      const token = await tokenCache.get();
      const data = await postJson(
        `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (data.code !== 0) {
        if (data.code === 99991663 || data.code === 99991661) tokenCache.invalidate(); // token expired
        throw new Error(`feishu send error ${data.code}: ${data.msg}`);
      }
    },
  };
}
