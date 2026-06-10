/**
 * Skill system — Anthropic-compatible composable capability modules.
 *
 * Skills use Markdown + YAML frontmatter format. When activated, a skill
 * injects its system prompt and can register custom handler tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// Tuning for lazy skill loading
const SKILL_BODY_LITE_THRESHOLD = 2000;
const SKILL_BODY_LITE_MAX_CHARS = 1500;

// Claude Code -> sky tool-name aliases
const CLAUDE_TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'edit_file',
  multiedit: 'edit_file',
  delete: 'delete_file',
  bash: 'run_bash',
  shell: 'run_bash',
  grep: 'grep',
  glob: 'file_search',
  search: 'code_search',
  websearch: 'web_search',
  webfetch: 'fetch_page',
  ls: 'list_directory',
  tree: 'tree',
  fetch: 'http_get',
  taskdone: 'task_done',
};

/**
 * A composable capability module for an agent.
 */
export class Skill {
  name: string;
  description: string;
  systemPrompt: string = '';
  requiredTools: string[] = [];
  tools: any[] = [];
  handler: ((agent: any, toolRegistry: any) => any[]) | null = null;
  model: string | null = null;
  temperature: number | null = null;
  maxTokens: number | null = null;
  triggers: string[] = [];
  resourceDir: string | null = null;
  license: string | null = null;
  allowedTools: string[] | null = null;
  sourcePath: string | null = null;
  bodyTruncated: boolean = false;
  metadata: Record<string, any> = {};

  private _fullBodyCache: { mtimeMs: number; body: string } | null = null;

  /**
   * Progressive disclosure, Claude Code semantics: the registry keeps only
   * the lightweight metadata (name/description + a lite body head); when the
   * skill ACTIVATES, the full SKILL.md body is read from disk and injected
   * into the system prompt. Cached by mtime, so live edits apply on the
   * next activation/rebuild.
   */
  fullBody(maxChars: number = 16000): string {
    if (!this.bodyTruncated || !this.sourcePath) return this.systemPrompt;
    try {
      const stat = fs.statSync(this.sourcePath);
      if (this._fullBodyCache && this._fullBodyCache.mtimeMs === stat.mtimeMs) {
        return this._fullBodyCache.body;
      }
      const text = fs.readFileSync(this.sourcePath, 'utf-8');
      const parsed = parseFrontmatter(text);
      let body = (parsed ? parsed.body : text).trim();
      if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…[正文超长已截断 — 其余部分见 ' + this.sourcePath + ']';
      this._fullBodyCache = { mtimeMs: stat.mtimeMs, body };
      return body;
    } catch {
      return this.systemPrompt; // fall back to the lite head
    }
  }

  constructor(config: Partial<SkillConfig>) {
    this.name = config.name || '';
    this.description = config.description || '';
    this.systemPrompt = config.systemPrompt || '';
    this.requiredTools = config.requiredTools || [];
    this.tools = config.tools || [];
    this.handler = config.handler || null;
    this.model = config.model || null;
    this.temperature = config.temperature ?? null;
    this.maxTokens = config.maxTokens ?? null;
    this.triggers = config.triggers || [];
    this.resourceDir = config.resourceDir || null;
    this.license = config.license || null;
    this.allowedTools = config.allowedTools || null;
    this.sourcePath = config.sourcePath || null;
    this.bodyTruncated = config.bodyTruncated || false;
    this.metadata = config.metadata || {};
  }

  /**
   * Load a skill from a Markdown file with YAML frontmatter.
   */
  static fromMarkdown(filePath: string): Skill | null {
    const p = path.resolve(filePath);
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf-8');
    } catch {
      return null;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed) return null;

    const { fm, body } = parsed;
    const name = (fm.name as string) || path.basename(p, '.md');
    const description = (fm.description as string) || '';

    const toolsRaw = fm.tools;
    const requiredTools: string[] = Array.isArray(toolsRaw)
      ? toolsRaw.filter((t: any) => typeof t === 'string')
      : [];

    // Config overrides
    const model = fm.model as string | undefined;
    const temperature = fm.temperature as number | undefined;
    const maxTokens = (fm.maxTokens ?? fm.max_tokens) as number | undefined;

    // Triggers
    const triggersRaw = fm.triggers;
    const triggers: string[] = Array.isArray(triggersRaw)
      ? triggersRaw.filter((t: any) => typeof t === 'string')
      : [];

    // Auto-derive triggers from description if not specified
    const finalTriggers = triggers.length > 0 ? triggers
      : (description ? deriveTriggersFromDescription(description) : []);

    // License and allowed-tools
    const licenseRaw = fm.license as string | undefined;
    const license = licenseRaw?.trim() || null;

    const allowedRaw = fm['allowed-tools'] ?? fm.allowed_tools;
    let allowedTools: string[] | null = null;
    if (Array.isArray(allowedRaw)) {
      allowedTools = allowedRaw.filter((t: any) => typeof t === 'string');
      if (allowedTools.length === 0) allowedTools = null;
    } else if (typeof allowedRaw === 'string' && allowedRaw.trim()) {
      allowedTools = allowedRaw.split(',').map((t: string) => t.trim()).filter(Boolean);
    }
    if (allowedTools) {
      allowedTools = allowedTools.map(t => normalizeClaudeToolName(t));
      // Dedupe preserving order
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const t of allowedTools) {
        if (!seen.has(t)) { seen.add(t); deduped.push(t); }
      }
      allowedTools = deduped;
    }

    // Preserve metadata fields
    const knownKeys = new Set([
      'name', 'description', 'tools', 'model', 'temperature', 'maxTokens', 'max_tokens',
      'triggers', 'license', 'allowed-tools', 'allowed_tools',
    ]);
    const extraMetadata: Record<string, any> = {};
    for (const [k, v] of Object.entries(fm)) {
      if (!knownKeys.has(k) && !k.startsWith('_')) {
        extraMetadata[k] = v;
      }
    }

    // Lazy-load large skill bodies
    let bodyStripped = body.trim();
    let bodyTruncated = false;
    if (bodyStripped.length > SKILL_BODY_LITE_THRESHOLD) {
      bodyStripped = extractSkillHead(bodyStripped, SKILL_BODY_LITE_MAX_CHARS);
      bodyTruncated = true;
    }

    return new Skill({
      name,
      description,
      systemPrompt: bodyStripped,
      requiredTools,
      model: typeof model === 'string' ? model : null,
      temperature: typeof temperature === 'number' ? temperature : null,
      maxTokens: typeof maxTokens === 'number' ? maxTokens : null,
      triggers: finalTriggers,
      license,
      allowedTools,
      sourcePath: p,
      bodyTruncated,
      metadata: extraMetadata,
    });
  }
}

interface SkillConfig {
  name: string;
  description: string;
  systemPrompt?: string;
  requiredTools?: string[];
  tools?: any[];
  handler?: ((agent: any, toolRegistry: any) => any[]) | null;
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  triggers?: string[];
  resourceDir?: string | null;
  license?: string | null;
  allowedTools?: string[] | null;
  sourcePath?: string | null;
  bodyTruncated?: boolean;
  metadata?: Record<string, any>;
}

/**
 * Parse YAML frontmatter from markdown text.
 * Returns { fm, body } or null.
 */
function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } | null {
  const match = text.match(/^---\s*\n(.*?)\n---\s*\n?(.*)/s);
  if (!match) return null;
  try {
    const fm = parseYaml(match[1]) || {};
    return { fm, body: match[2] };
  } catch {
    return null;
  }
}

/**
 * Normalize a Claude Code tool name into sky's registry name.
 */
function normalizeClaudeToolName(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  // Strip permission scoping: Bash(ls *) -> Bash
  const paren = s.indexOf('(');
  if (paren > 0) s = s.slice(0, paren).trim();
  // Check if it's already a valid sky name
  const aliasValues = new Set(Object.values(CLAUDE_TOOL_ALIASES));
  if (aliasValues.has(s)) return s;
  return CLAUDE_TOOL_ALIASES[s.toLowerCase()] ?? s;
}

/**
 * Extract the head of a SKILL.md body — title plus first major section.
 */
function extractSkillHead(body: string, maxChars: number): string {
  const out: string[] = [];
  let charCount = 0;
  let h2Count = 0;
  for (const line of body.split('\n')) {
    const isH2 = line.startsWith('## ') && !line.startsWith('### ');
    if (isH2) {
      h2Count++;
      if (h2Count > 1) break;
    }
    if (out.length > 0 && charCount + line.length + 1 > maxChars) break;
    out.push(line);
    charCount += line.length + 1;
  }
  return out.join('\n').trimEnd();
}

// Patterns for auto-deriving triggers
const TRIGGER_QUOTED = /["'"'""]([^"'""\n]{1,40})["'""']/g;
const TRIGGER_EXT = /(?<![A-Za-z0-9])\.[A-Za-z0-9]{2,6}\b/g;
const TRIGGER_STRIP = " \t,.;:!?，。、；：！？、。";

/**
 * Pull candidate trigger phrases out of a skill description.
 */
function deriveTriggersFromDescription(description: string): string[] {
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TRIGGER_QUOTED.exec(description)) !== null) {
    raw.push(m[1]);
  }
  while ((m = TRIGGER_EXT.exec(description)) !== null) {
    raw.push(m[0]);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (let token of raw) {
    token = token.replace(/[ \t,.;:!?，。、；：！？、。]+$/, '').replace(/^[ \t]+/, '');
    if (!token || token.length < 2) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Central registry for all available skills.
 */
export class SkillRegistry {
  private _skills: Map<string, Skill> = new Map();

  register(skill: Skill): void {
    this._skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this._skills.get(name);
  }

  getSkills(names?: string[]): Skill[] {
    if (!names) return Array.from(this._skills.values());
    return names.map(n => this._skills.get(n)).filter(Boolean) as Skill[];
  }

  listNames(): string[] {
    return Array.from(this._skills.keys());
  }

  merge(other: SkillRegistry): void {
    for (const [name, skill] of other._skills) {
      this._skills.set(name, skill);
    }
  }

  /**
   * Load folder-style skills: `<root>/<skill-name>/SKILL.md` (the Claude
   * Code layout). Only SKILL.md is parsed — sibling files (reference.md,
   * scripts/…) are the skill's resources, not separate skills. The skill's
   * resourceDir is its own folder so relative references resolve.
   */
  loadSkillFolders(rootDir: string): Skill[] {
    const loaded: Skill[] = [];
    let root: string;
    try {
      root = path.resolve(rootDir.replace(/^~/, process.env.HOME || process.env.USERPROFILE || ''));
    } catch {
      return loaded;
    }
    if (!fs.existsSync(root)) return loaded;

    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return loaded;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      const skillDir = path.join(root, entry);
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const skill = Skill.fromMarkdown(skillFile);
      if (skill) {
        skill.resourceDir = skillDir;
        this.register(skill);
        loaded.push(skill);
      }
    }
    return loaded;
  }

  /**
   * Load all .md skill files from a directory (Anthropic format).
   */
  loadSkillsFromDirectory(directory: string): Skill[] {
    const loaded: Skill[] = [];
    let dirPath: string;
    try {
      dirPath = path.resolve(directory.replace(/^~/, process.env.HOME || process.env.USERPROFILE || ''));
    } catch {
      return loaded;
    }

    if (!fs.existsSync(dirPath)) return loaded;

    let entries: string[];
    try {
      entries = fs.readdirSync(dirPath);
    } catch {
      return loaded;
    }

    for (const entry of entries.sort()) {
      if (entry.startsWith('_') || entry.startsWith('.') || !entry.endsWith('.md')) continue;
      const fullPath = path.join(dirPath, entry);
      const skill = Skill.fromMarkdown(fullPath);
      if (skill) {
        skill.resourceDir = dirPath;
        this.register(skill);
        loaded.push(skill);
      }
    }
    return loaded;
  }
}

// Global skill registry singleton
export const globalSkillRegistry = new SkillRegistry();
