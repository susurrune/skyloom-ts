/**
 * Text-to-Speech integration using Volcano Engine (Doubao) TTS API.
 * Uses POST to https://openspeech.bytedance.com/api/v3/tts/unidirectional.
 */

const HTTP_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export interface VoiceOption {
  key: string;
  name: string;
  desc: string;
  voiceType: string;
}

export const VOICE_CATALOG: VoiceOption[] = [
  { key: 'xiaohe', name: '小河', desc: '温柔自然女声', voiceType: 'zh_female_xiaohe_uranus_bigtts' },
  { key: 'qingxinnvsheng', name: '清新女声', desc: '清澈自然女声', voiceType: 'zh_female_qingxinnvsheng_uranus_bigtts' },
  { key: 'cancan', name: '灿灿', desc: '活力甜美少女音', voiceType: 'zh_female_cancan_uranus_bigtts' },
  { key: 'sajiaoxuemei', name: '撒娇雪梅', desc: '甜美撒娇少女音', voiceType: 'zh_female_sajiaoxuemei_uranus_bigtts' },
  { key: 'meilinvyou', name: '魅力女游', desc: '温柔魅力女声', voiceType: 'zh_female_meilinvyou_uranus_bigtts' },
  { key: 'xiaoshan', name: '小杉', desc: '温暖磁性男声', voiceType: 'zh_male_xiaoshan_uranus_bigtts' },
];

export interface TTSOptions {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
  apiKey?: string;
}

export interface TTSResult {
  success: boolean;
  audioBase64?: string;
  format?: string;
  error?: string;
}

/**
 * Convert text to speech using Volcano Engine TTS API.
 */
export async function textToSpeech(options: TTSOptions): Promise<TTSResult> {
  const { text, voice = 'zh_female_xiaohe_uranus_bigtts', speed = 1.0, pitch = 1.0 } = options;

  if (!text || !text.trim()) {
    return { success: false, error: 'Text is required' };
  }

  const apiKey = options.apiKey || process.env.VOLC_ACCESS_TOKEN;
  if (!apiKey) {
    return { success: false, error: 'API key not configured. Set VOLC_ACCESS_TOKEN or pass apiKey.' };
  }

  const payload = {
    app: { appid: process.env.VOLC_APP_ID || '' },
    user: { uid: 'skyloom' },
    request: {
      reqid: Math.random().toString(36).slice(2, 14),
      text,
      text_type: 'plain',
      operation: 'query',
      frontend_type: 'unitTson',
      voice: { voice_type: voice, speed_rate: speed, pitch_rate: pitch },
      audio: { audio_type: 'mp3' },
    },
  };

  try {
    const response = await fetch(HTTP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const data: any = await response.json();
    if (data.code !== 3000) {
      return { success: false, error: `API error: ${data.code} - ${data.message || 'unknown'}` };
    }
    return { success: true, audioBase64: data.data, format: 'mp3' };
  } catch (e: any) {
    return { success: false, error: `TTS request failed: ${e.message || e}` };
  }
}

/**
 * List available TTS voices.
 */
export function listVoices(): VoiceOption[] {
  return [...VOICE_CATALOG];
}
