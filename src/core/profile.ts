/**
 * Local user profile (用户画像) + per-agent custom personas.
 *
 * Everything here lives under ~/.skyloom/ and never leaves the machine:
 *
 * - profile.json — a free-form dict of facts about the user.
 * - memories.json — running narrative of moods, life events, things worth following up on.
 * - personas/<agent>.md — optional custom role for a specific agent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { USER_CONFIG_DIR, AGENT_NAMES } from './config';

const VALID_AGENTS = new Set<string>(AGENT_NAMES);

// Keep only the most recent N memories in the prompt + on disk.
const MEMORY_CAP = 40;
// When over cap, fold this many of the oldest notes into ONE digest entry.
const FOLD_BATCH = 8;

// Pluggable summarizer for memory folding.
let _summarizer: ((notes: string[]) => string) | null = null;

export function setMemorySummarizer(fn: (notes: string[]) => string): void {
  _summarizer = fn;
}

function profilePath(): string {
  return path.join(USER_CONFIG_DIR, 'profile.json');
}

function memoriesPath(): string {
  return path.join(USER_CONFIG_DIR, 'memories.json');
}

function personaPath(agent: string): string {
  return path.join(USER_CONFIG_DIR, 'personas', `${agent}.md`);
}

// ── User profile ──

export function loadProfile(): Record<string, string> {
  const p = profilePath();
  if (!fs.existsSync(p)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return typeof data === 'object' && data !== null ? data : {};
  } catch {
    return {};
  }
}

export function saveProfile(data: Record<string, string>): void {
  const p = profilePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

export function setProfileField(key: string, value: string): void {
  key = (key || '').trim();
  if (!key) return;
  const data = loadProfile();
  data[key] = value;
  saveProfile(data);
}

export function clearProfileField(key?: string | null): void {
  if (key == null) {
    try {
      const p = profilePath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
    return;
  }
  const data = loadProfile();
  delete data[key];
  saveProfile(data);
}

export function formatProfileForPrompt(lang: string = 'zh'): string {
  const data = loadProfile();
  const entries = Object.entries(data);
  if (entries.length === 0) return '';

  const lines = entries.map(([k, v]) => {
    return lang === 'en' ? `- ${k}: ${v}` : `- ${k}：${v}`;
  });
  const body = lines.join('\n');

  if (lang === 'en') {
    return '\n\n## About the user (remember this and use it naturally)\n' + body;
  }
  return '\n\n## 关于用户（记住，并在对话中自然运用，不要生硬复述）\n' + body;
}

// ── Emotional / narrative memory ──

export function loadMemories(): Record<string, any>[] {
  const p = memoriesPath();
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function norm(text: string): string {
  return text.toLowerCase().split('').filter(c => !c.match(/\s/) && !'，。,.、!！?？~…「」"\'，。、；：？！'.includes(c)).join('');
}

function writeMemories(items: Record<string, any>[]): void {
  const p = memoriesPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

function digest(notes: string[]): string {
  const seen: string[] = [];
  for (let n of notes) {
    n = n.trim();
    if (n.startsWith('早些时候：')) {
      n = n.slice('早些时候：'.length);
    }
    for (const part of n.split('；')) {
      const p = part.trim();
      if (p && !seen.includes(p)) {
        seen.push(p);
      }
    }
  }
  let joined = seen.join('；');
  if (joined.length > 180) {
    joined = joined.slice(0, 179) + '…';
  }
  return '早些时候：' + joined;
}

function summarizeNotes(notes: string[]): string {
  if (_summarizer) {
    try {
      const out = _summarizer(notes);
      if (out && out.trim()) return out.trim();
    } catch { /* ignore */ }
  }
  return digest(notes);
}

function foldOldest(items: Record<string, any>[]): Record<string, any>[] {
  let foldN = (items.length - MEMORY_CAP) + FOLD_BATCH;
  foldN = Math.min(foldN, items.length - 1);
  if (foldN <= 0) return items.slice(-MEMORY_CAP);

  const old = items.slice(0, foldN);
  const rest = items.slice(foldN);
  const digestEntry: Record<string, any> = {
    ts: old[old.length - 1]?.ts || new Date().toISOString().slice(0, 10),
    note: summarizeNotes(old.map(m => String(m.note || ''))),
    summary: true,
  };
  return [digestEntry, ...rest];
}

export function appendMemory(note: string): boolean {
  note = (note || '').trim();
  if (!note) return false;

  const items = loadMemories();
  const key = norm(note);

  if (key) {
    for (const m of items) {
      if (norm(String(m.note || '')) === key) {
        m.ts = new Date().toISOString().slice(0, 10); // refresh recency
        if (note.length > String(m.note || '').length) {
          m.note = note; // keep the richer phrasing
        }
        writeMemories(items);
        return true;
      }
    }
  }

  items.push({ ts: new Date().toISOString().slice(0, 10), note });
  if (items.length > MEMORY_CAP) {
    writeMemories(foldOldest(items));
  } else {
    writeMemories(items);
  }
  return true;
}

export function clearMemories(): void {
  try {
    const p = memoriesPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}

export function formatMemoriesForPrompt(lang: string = 'zh', limit: number = 12): string {
  const items = loadMemories();
  if (items.length === 0) return '';

  const recent = items.slice(-limit);
  const lines = recent.map((m: any) => `- [${m.ts || ''}] ${m.note || ''}`);
  const body = lines.join('\n');

  if (lang === 'en') {
    return '\n\n## What you remember about them (recent context — weave in naturally, never recite)\n' + body;
  }
  return '\n\n## 你记得关于 ta 的事（近期，自然带出，别生硬复述）\n' + body;
}

// ── Per-agent custom persona ──

export function loadPersona(agent: string): string | null {
  const p = personaPath(agent);
  if (!fs.existsSync(p)) return null;
  try {
    const text = fs.readFileSync(p, 'utf-8').trim();
    return text || null;
  } catch {
    return null;
  }
}

export function savePersona(agent: string, text: string): boolean {
  if (!VALID_AGENTS.has(agent)) return false;
  const p = personaPath(agent);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, text.trim() + '\n', 'utf-8');
  return true;
}

export function clearPersona(agent: string): void {
  try {
    const p = personaPath(agent);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}
