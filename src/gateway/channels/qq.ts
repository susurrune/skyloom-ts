/**
 * QQ official-bot channel adapter (webhook mode, QQ 频道/群 机器人).
 *
 * Auth/crypto: QQ uses Ed25519. The signing seed is the bot secret repeated to
 * 32 bytes. Two webhook concerns:
 *   - validation (op 13): the platform sends { d: { plain_token, event_ts } };
 *     we reply { plain_token, signature } where signature = ed25519(event_ts +
 *     plain_token).
 *   - event signature: each push carries X-Signature-Ed25519 (hex) and
 *     X-Signature-Timestamp; verify ed25519 over (timestamp + body).
 *
 * Inbound message events: GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE /
 * AT_MESSAGE_CREATE. Outbound: getAppAccessToken (cached) then the v2 messages
 * API (passive reply via msg_id). Config (channels.qq): { appId, secret,
 *   agent? }. Env fallback: QQ_BOT_APPID, QQ_BOT_SECRET.
 */

import * as crypto from 'crypto';
import { getLogger } from '../../core/logger';
import { resolveSecret, postJson, TokenCache } from '../helpers';
import type { ChannelAdapter, MediaAttachment, RawRequest, ReplyTarget, WebhookOutcome } from '../types';

const log = getLogger('channel-qq');

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Repeat the bot secret to a 32-byte Ed25519 seed (QQ's scheme). */
export function qqSeed(secret: string): Buffer {
  let s = secret;
  while (s.length < 32) s = s + s;
  return Buffer.from(s.slice(0, 32), 'utf8');
}

function privKeyFromSeed(seed: Buffer): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Sign `event_ts + plain_token` for the validation handshake; returns hex. */
export function qqSignValidation(secret: string, eventTs: string, plainToken: string): string {
  const priv = privKeyFromSeed(qqSeed(secret));
  return crypto.sign(null, Buffer.from(eventTs + plainToken, 'utf8'), priv).toString('hex');
}

/** Verify an event push signature (hex) over `timestamp + body`. */
export function qqVerify(secret: string, timestamp: string, body: Buffer, signatureHex: string): boolean {
  try {
    const pub = crypto.createPublicKey(privKeyFromSeed(qqSeed(secret)));
    const msg = Buffer.concat([Buffer.from(timestamp, 'utf8'), body]);
    return crypto.verify(null, msg, pub, Buffer.from(signatureHex, 'hex'));
  } catch (e) {
    log.warn('qq_verify_error', { error: String(e) });
    return false;
  }
}

export function createQQAdapter(cfg: any, env: NodeJS.ProcessEnv): ChannelAdapter | null {
  const appId = resolveSecret(cfg.appId != null ? String(cfg.appId) : undefined, env, 'QQ_BOT_APPID');
  const secret = resolveSecret(cfg.secret, env, 'QQ_BOT_SECRET');
  if (!appId || !secret) return null;

  const tokenCache = new TokenCache(async () => {
    const data = await postJson('https://bots.qq.com/app/getAppAccessToken', {
      appId, clientSecret: secret,
    });
    if (!data.access_token) throw new Error(`qq token error: ${JSON.stringify(data).slice(0, 120)}`);
    return { token: data.access_token, expiresInSec: Number(data.expires_in) || 7200 };
  });

  const authHeaders = async () => ({ Authorization: `QQBot ${await tokenCache.get()}`, 'X-Union-Appid': appId });

  return {
    id: 'qq',
    name: 'QQ Bot',
    defaultAgent: cfg.agent || 'fair',

    async handleWebhook(req: RawRequest): Promise<WebhookOutcome> {
      let payload: any;
      try { payload = JSON.parse(req.body.toString('utf8') || '{}'); } catch { return { response: { status: 400, body: 'bad json' } }; }

      // Validation handshake (op 13) — no signature header on this one.
      if (payload.op === 13 && payload.d?.plain_token && payload.d?.event_ts) {
        const signature = qqSignValidation(secret, String(payload.d.event_ts), String(payload.d.plain_token));
        return { response: { status: 200, contentType: 'application/json', body: JSON.stringify({ plain_token: payload.d.plain_token, signature }) } };
      }

      // Verify the event push signature.
      const sig = (req.headers['x-signature-ed25519'] as string) || '';
      const ts = (req.headers['x-signature-timestamp'] as string) || '';
      if (sig && ts && !qqVerify(secret, ts, req.body, sig)) {
        return { response: { status: 403, body: 'bad signature' } };
      }

      if (payload.op !== 0) return { response: { status: 200, body: '' } }; // not a dispatch

      const t = payload.t as string;
      const d = payload.d || {};
      const content = String(d.content || '').replace(/<@!?\d+>/g, '').trim();
      const msgId = d.id as string;

      let replyTo: ReplyTarget | null = null;
      if (t === 'GROUP_AT_MESSAGE_CREATE') replyTo = { channel: 'qq', kind: 'group', groupOpenid: d.group_openid, msgId };
      else if (t === 'C2C_MESSAGE_CREATE') replyTo = { channel: 'qq', kind: 'c2c', userOpenid: d.author?.user_openid, msgId };
      else if (t === 'AT_MESSAGE_CREATE' || t === 'MESSAGE_CREATE') replyTo = { channel: 'qq', kind: 'channel', channelId: d.channel_id, msgId };

      // QQ delivers images/files as an attachments array on the event.
      const media: MediaAttachment[] = [];
      for (const att of (Array.isArray(d.attachments) ? d.attachments : [])) {
        const ct = String(att?.content_type || '');
        const kind: MediaAttachment['kind'] = ct.startsWith('image') ? 'image'
          : ct.startsWith('audio') || ct.startsWith('voice') ? 'audio'
          : ct.startsWith('video') ? 'video' : 'file';
        media.push({ kind, ref: att?.id, filename: att?.filename, mimeType: att?.content_type, url: att?.url });
      }

      if (!replyTo || (!content && media.length === 0)) return { response: { status: 200, body: '' } };

      const userId = d.author?.user_openid || d.author?.id || d.author?.member_openid || 'unknown';
      return {
        response: { status: 200, body: '' },
        message: {
          channel: 'qq',
          conversationId: (replyTo.groupOpenid as string) || (replyTo.channelId as string) || (userId as string),
          userId,
          text: content,
          media: media.length ? media : undefined,
          replyTo,
          raw: payload,
        },
      };
    },

    async send(target: ReplyTarget, text: string): Promise<void> {
      const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
      const msgId = target.msgId as string | undefined;
      const payload: any = { msg_type: 0, content: text };
      if (msgId) payload.msg_id = msgId; // passive reply within the allowed window

      let url: string;
      if (target.kind === 'group') url = `https://api.sgroup.qq.com/v2/groups/${target.groupOpenid}/messages`;
      else if (target.kind === 'c2c') url = `https://api.sgroup.qq.com/v2/users/${target.userOpenid}/messages`;
      else url = `https://api.sgroup.qq.com/channels/${target.channelId}/messages`;

      try {
        await postJson(url, payload, { headers });
      } catch (e: any) {
        if (e?.response?.status === 401) tokenCache.invalidate();
        throw new Error(`qq send error: ${e?.response?.status || ''} ${String(e?.message || e).slice(0, 120)}`);
      }
    },
  };
}
