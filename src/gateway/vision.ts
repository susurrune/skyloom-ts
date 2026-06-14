/**
 * Vision describe — turn an inbound image into a text description so the agent
 * can "see" what the user sent, without rewiring the core text-only LLM loop.
 *
 * Self-contained on purpose: a single OpenAI-compatible chat/completions call
 * with an image_url (base64 data URL) content block. The model + key are
 * resolved from config.channels.<id>.visionModel / config.llm.vision_model
 * (default gpt-4o-mini), falling back to env keys the same way the rest of
 * Skyloom does. If no key/model is available, vision is skipped silently and the
 * gateway just uses the media description line.
 */

import axios from 'axios';
import { getLogger } from '../core/logger';
import type { LoadedMedia } from './helpers';

const log = getLogger('gateway-vision');

/** OpenAI-compatible base URL for a provider inferred from the model id. */
function baseUrlFor(model: string): string {
  const l = model.toLowerCase();
  if (l.includes('claude')) return 'https://api.anthropic.com/v1'; // not OpenAI-shaped; skipped below
  if (l.includes('gemini')) return 'https://generativelanguage.googleapis.com/v1beta/openai';
  if (l.includes('grok') || l.includes('xai')) return 'https://api.x.ai/v1';
  if (l.includes('qwen') || l.includes('dashscope')) return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  return 'https://api.openai.com/v1';
}

/** Resolve an API key for the vision model from env (best-effort). */
function keyFor(model: string, env: NodeJS.ProcessEnv): string | undefined {
  const l = model.toLowerCase();
  const candidates = l.includes('gemini') ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
    : l.includes('grok') || l.includes('xai') ? ['XAI_API_KEY']
    : l.includes('qwen') || l.includes('dashscope') ? ['DASHSCOPE_API_KEY', 'QWEN_API_KEY']
    : ['OPENAI_API_KEY'];
  for (const c of candidates) if (env[c]) return env[c];
  return undefined;
}

export interface VisionOptions {
  model?: string;
  env?: NodeJS.ProcessEnv;
  prompt?: string;
}

/**
 * Describe one or more images. Returns a description string, or null if vision
 * is unavailable (no key/model) or fails — callers fall back to the media line.
 */
export async function describeImages(images: LoadedMedia[], opts: VisionOptions = {}): Promise<string | null> {
  if (!images.length) return null;
  const env = opts.env || process.env;
  const model = opts.model || 'gpt-4o-mini';
  // Anthropic isn't OpenAI-chat-shaped here; skip to keep this helper simple.
  if (model.toLowerCase().includes('claude')) return null;
  const key = keyFor(model, env);
  if (!key) return null;

  const prompt = opts.prompt || '请用中文简洁描述这些图片的内容(关键物体、文字、场景);如果含可读文字请转写出来。';
  const content: any[] = [{ type: 'text', text: prompt }];
  for (const img of images.slice(0, 4)) {
    const mime = img.contentType || 'image/png';
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${img.data.toString('base64')}` } });
  }

  try {
    const res = await axios.post(
      `${baseUrlFor(model)}/chat/completions`,
      { model, messages: [{ role: 'user', content }], max_tokens: 500, temperature: 0.2 },
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, timeout: 30000, validateStatus: (s) => s >= 200 && s < 300 },
    );
    const text = res.data?.choices?.[0]?.message?.content;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch (e) {
    log.warn('vision_describe_failed', { model, error: String(e).slice(0, 160) });
    return null;
  }
}
