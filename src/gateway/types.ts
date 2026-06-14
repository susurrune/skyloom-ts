/**
 * Channel gateway contract — the minimal, channel-agnostic interface every
 * messaging integration (Feishu / WeCom / QQ / …) implements.
 *
 * Distilled from OpenClaw's channel architecture (which spans ~250 files per
 * channel) down to the essence: a channel receives an inbound webhook, the
 * gateway normalizes it to an InboundMessage, routes it to an agent, and the
 * channel sends the reply back out. Signature verification and the platform's
 * URL-verification handshake live behind `handleWebhook`, so the gateway core
 * stays platform-neutral.
 */

import type { IncomingHttpHeaders } from 'http';

/** A normalized inbound message from any channel. */
export interface InboundMessage {
  /** Channel id, e.g. 'feishu'. */
  channel: string;
  /** Stable conversation/session key (chat id or user id) for memory routing. */
  conversationId: string;
  /** Platform user id of the sender. */
  userId: string;
  /** Plain text the user sent (media/stripped to text where possible). */
  text: string;
  /** Where to send the reply (channel-specific opaque target). */
  replyTo: ReplyTarget;
  /** Media attachments on this message (image / audio / file / …). */
  media?: MediaAttachment[];
  /** Raw event for adapters that need more than the normalized fields. */
  raw?: unknown;
}

/** A non-text attachment, normalized across channels. */
export interface MediaAttachment {
  kind: 'image' | 'audio' | 'video' | 'file' | 'sticker' | 'other';
  /** Channel-specific id/key used to fetch the binary (image_key, media_id, url…). */
  ref?: string;
  /** Original filename, when the platform provides one. */
  filename?: string;
  /** MIME type, when known. */
  mimeType?: string;
  /** Direct URL, when the platform provides one. */
  url?: string;
}

/** Render a media list into a compact, model-readable description line. */
export function describeMedia(media: MediaAttachment[] | undefined): string {
  if (!media || media.length === 0) return '';
  const parts = media.map((m) => {
    const label = m.filename || m.ref || m.url || '';
    const tag = label ? `${m.kind}: ${label}` : m.kind;
    return `[${tag}]`;
  });
  return parts.join(' ');
}

/** Opaque, channel-specific destination for an outbound reply. */
export interface ReplyTarget {
  channel: string;
  [key: string]: unknown;
}

/**
 * The result of an adapter handling a raw webhook request. Exactly one of:
 *  - `response`: reply immediately to the HTTP request (URL verification
 *    challenge, ack, or signature failure) and do NOT route to an agent.
 *  - `message`: a normalized inbound message to route to an agent. `response`
 *    may also be set to ack the webhook synchronously (most platforms require a
 *    fast 200) while the agent reply is delivered asynchronously via `send`.
 *  - neither: nothing to do (duplicate/ignored event); gateway returns 200.
 */
export interface WebhookOutcome {
  response?: HttpResponse;
  message?: InboundMessage;
}

export interface HttpResponse {
  status: number;
  body?: string;
  contentType?: string;
}

/** The raw HTTP request passed to an adapter's webhook handler. */
export interface RawRequest {
  method: string;
  headers: IncomingHttpHeaders;
  query: URLSearchParams;
  body: Buffer;
}

/** A channel integration. Constructed from its config block by a factory. */
export interface ChannelAdapter {
  /** Channel id (matches the /webhook/<id> route and config key). */
  readonly id: string;
  /** Human label for logs/status. */
  readonly name: string;
  /** Default agent to route this channel's messages to (config override wins). */
  readonly defaultAgent?: string;

  /** Optional one-time setup (token prefetch, websocket connect, …). */
  start?(): Promise<void>;
  /** Optional teardown on gateway shutdown. */
  stop?(): Promise<void>;

  /**
   * Handle a raw webhook request: verify signature, answer the platform's
   * URL-verification handshake, decrypt if needed, and either return an
   * immediate HTTP response and/or a normalized message to route.
   */
  handleWebhook(req: RawRequest): Promise<WebhookOutcome>;

  /** Send a text reply back to the channel. */
  send(target: ReplyTarget, text: string): Promise<void>;
}

/** Factory signature: build an adapter from its config block (or null if disabled/misconfigured). */
export type ChannelFactory = (cfg: any, env: NodeJS.ProcessEnv) => ChannelAdapter | null;
