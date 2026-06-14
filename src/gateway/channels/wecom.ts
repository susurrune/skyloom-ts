/**
 * WeCom (企业微信) channel adapter.
 *
 * Uses the official "receive messages" callback with the standard WeWork
 * crypto: msg_signature = sha1(sort(token, timestamp, nonce, echostr|encrypt)),
 * and AES-256-CBC (PKCS7) where the key is base64(EncodingAESKey + "=") and the
 * plaintext is [16B random][4B big-endian msg-len][msg][receiveid].
 *
 * Inbound is XML. GET verifies the callback URL (echo the decrypted echostr);
 * POST carries the encrypted message. We extract text from <Content>.
 *
 * Outbound uses the application message API (message/send) with the agent's
 * gettoken. Config (channels.wecom): { corpId, corpSecret, token, encodingAesKey,
 *   agentId, agent? }. Env fallback: WECOM_CORP_ID, WECOM_CORP_SECRET,
 *   WECOM_TOKEN, WECOM_AES_KEY, WECOM_AGENT_ID.
 */

import * as crypto from 'crypto';
import { getLogger } from '../../core/logger';
import { resolveSecret, postJson, getJson, TokenCache } from '../helpers';
import type { ChannelAdapter, MediaAttachment, RawRequest, ReplyTarget, WebhookOutcome } from '../types';

const log = getLogger('channel-wecom');

/** WeWork msg_signature: sha1 over the sorted concatenation. */
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

/** Decrypt a WeWork AES message. Returns { message, receiveId }. */
export function decryptWecom(encrypt: string, encodingAesKey: string): { message: string; receiveId: string } {
  const key = Buffer.from(encodingAesKey + '=', 'base64'); // 32 bytes
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()]);
  // PKCS7 unpad
  const pad = decrypted[decrypted.length - 1];
  if (pad > 0 && pad <= 32) decrypted = decrypted.subarray(0, decrypted.length - pad);
  // [16B random][4B msg len BE][msg][receiveid]
  const content = decrypted.subarray(16);
  const msgLen = content.readUInt32BE(0);
  const message = content.subarray(4, 4 + msgLen).toString('utf8');
  const receiveId = content.subarray(4 + msgLen).toString('utf8');
  return { message, receiveId };
}

function xmlField(xml: string, tag: string): string {
  const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
  if (cdata) return cdata[1];
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return plain ? plain[1] : '';
}

export function createWecomAdapter(cfg: any, env: NodeJS.ProcessEnv): ChannelAdapter | null {
  const corpId = resolveSecret(cfg.corpId, env, 'WECOM_CORP_ID');
  const corpSecret = resolveSecret(cfg.corpSecret, env, 'WECOM_CORP_SECRET');
  const token = resolveSecret(cfg.token, env, 'WECOM_TOKEN');
  const aesKey = resolveSecret(cfg.encodingAesKey, env, 'WECOM_AES_KEY');
  const agentId = resolveSecret(cfg.agentId != null ? String(cfg.agentId) : undefined, env, 'WECOM_AGENT_ID');
  if (!corpId || !corpSecret || !token || !aesKey) return null;

  const tokenCache = new TokenCache(async () => {
    const data = await getJson(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`,
    );
    if (data.errcode !== 0) throw new Error(`wecom token error ${data.errcode}: ${data.errmsg}`);
    return { token: data.access_token, expiresInSec: data.expires_in ?? 7200 };
  });

  const verify = (req: RawRequest, encrypt: string): boolean => {
    const sig = req.query.get('msg_signature') || '';
    const ts = req.query.get('timestamp') || '';
    const nonce = req.query.get('nonce') || '';
    return sig === wecomSignature(token, ts, nonce, encrypt);
  };

  return {
    id: 'wecom',
    name: 'WeCom (企业微信)',
    defaultAgent: cfg.agent || 'fair',

    async handleWebhook(req: RawRequest): Promise<WebhookOutcome> {
      // URL verification: GET with echostr.
      if (req.method === 'GET') {
        const echostr = req.query.get('echostr') || '';
        if (!verify(req, echostr)) return { response: { status: 403, body: 'bad signature' } };
        try {
          const { message } = decryptWecom(echostr, aesKey);
          return { response: { status: 200, body: message } };
        } catch (e) {
          log.warn('wecom_echostr_decrypt_failed', { error: String(e) });
          return { response: { status: 400, body: 'decrypt failed' } };
        }
      }

      // Message callback: POST with <Encrypt> XML.
      const xml = req.body.toString('utf8');
      const encrypt = xmlField(xml, 'Encrypt');
      if (!encrypt) return { response: { status: 400, body: 'no encrypt' } };
      if (!verify(req, encrypt)) return { response: { status: 403, body: 'bad signature' } };

      let inner: string;
      try { inner = decryptWecom(encrypt, aesKey).message; }
      catch (e) { log.warn('wecom_decrypt_failed', { error: String(e) }); return { response: { status: 400, body: 'decrypt failed' } }; }

      const msgType = xmlField(inner, 'MsgType');
      const fromUser = xmlField(inner, 'FromUserName');
      let text = '';
      const media: MediaAttachment[] = [];
      switch (msgType) {
        case 'text': text = xmlField(inner, 'Content').trim(); break;
        case 'image': media.push({ kind: 'image', ref: xmlField(inner, 'MediaId'), url: xmlField(inner, 'PicUrl') || undefined }); break;
        case 'voice': media.push({ kind: 'audio', ref: xmlField(inner, 'MediaId'), filename: xmlField(inner, 'MediaId') + '.' + (xmlField(inner, 'Format') || 'amr') }); break;
        case 'video': media.push({ kind: 'video', ref: xmlField(inner, 'MediaId') }); break;
        case 'file': media.push({ kind: 'file', ref: xmlField(inner, 'MediaId'), filename: xmlField(inner, 'FileName') || undefined }); break;
        case 'location': text = `[位置] ${xmlField(inner, 'Label')} (${xmlField(inner, 'Location_X')},${xmlField(inner, 'Location_Y')})`; break;
        default: text = `[${msgType} 消息]`;
      }

      // Ack the callback immediately (empty 200); reply is pushed via the API.
      return {
        response: { status: 200, body: '' },
        message: (text || media.length) ? {
          channel: 'wecom',
          conversationId: fromUser,
          userId: fromUser,
          text,
          media: media.length ? media : undefined,
          replyTo: { channel: 'wecom', toUser: fromUser },
          raw: inner,
        } : undefined,
      };
    },

    async send(target: ReplyTarget, text: string): Promise<void> {
      const toUser = target.toUser as string;
      if (!toUser || !agentId) return;
      const accessToken = await tokenCache.get();
      const data = await postJson(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
        { touser: toUser, msgtype: 'text', agentid: Number(agentId), text: { content: text } },
      );
      if (data.errcode !== 0) {
        if (data.errcode === 42001 || data.errcode === 40014) tokenCache.invalidate();
        throw new Error(`wecom send error ${data.errcode}: ${data.errmsg}`);
      }
    },
  };
}
