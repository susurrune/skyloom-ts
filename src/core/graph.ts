/**
 * 简易知识图谱 — entity-relation storage in SQLite.
 *
 * Lightweight triple store: (subject, predicate, object) with metadata.
 * Used for: project info, tool preferences, dependency relationships.
 *
 * Schema:
 *   CREATE TABLE triples (subj, pred, obj, agent, ts, meta)
 *
 * Queries:
 *   - Find all relations for an entity
 *   - Find all entities matching a predicate
 *   - Transitive closure (2-hop max for performance)
 */

import * as fs from "fs";
import * as path from "path";
import { USER_CONFIG_DIR } from "./config";
import { getLogger } from "./logger";

const log = getLogger("graph");

/* ═══════════════════════════════════════
   Triple store — in-memory + optional persistence
   ═══════════════════════════════════════ */
interface Triple {
  subj: string;
  pred: string;
  obj: string;
  agent: string;
  ts: string;
  meta?: Record<string, string>;
}

export class KnowledgeGraph {
  private triples: Triple[] = [];
  private indexPath: string;

  constructor(name: string = "default") {
    this.indexPath = path.join(USER_CONFIG_DIR, `kg_${name}.json`);
    this.load();
  }

  /** Add a fact: (subject, predicate, object). */
  add(subj: string, pred: string, obj: string, agent: string = "system", meta?: Record<string, string>): void {
    // Deduplicate
    const exists = this.triples.find(t => t.subj === subj && t.pred === pred && t.obj === obj);
    if (exists) { exists.ts = new Date().toISOString(); if (meta) exists.meta = { ...exists.meta, ...meta }; return; }

    this.triples.push({ subj, pred, obj, agent, ts: new Date().toISOString(), meta });
    if (this.triples.length > 5000) this.triples.splice(0, this.triples.length - 5000);
    this.save();
  }

  /** Find all facts about an entity. */
  about(entity: string, limit: number = 20): Triple[] {
    return this.triples.filter(t => t.subj === entity || t.obj === entity).slice(-limit);
  }

  /** Find all subjects matching a predicate. */
  byPredicate(pred: string): Triple[] {
    return this.triples.filter(t => t.pred === pred);
  }

  /** Find all objects for a subject-predicate pair. */
  find(subj: string, pred: string): Triple[] {
    return this.triples.filter(t => t.subj === subj && t.pred === pred);
  }

  /** Transitive expansion: 2-hop from a starting entity. */
  expand(entity: string, maxDepth: number = 2): Triple[] {
    const seen = new Set<Triple>();
    const queue = [entity];
    for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
      const current = queue.shift()!;
      const facts = this.about(current, 10);
      for (const f of facts) {
        if (seen.has(f)) continue;
        seen.add(f);
        if (f.subj === current && !queue.includes(f.obj)) queue.push(f.obj);
        if (f.obj === current && !queue.includes(f.subj)) queue.push(f.subj);
      }
    }
    return Array.from(seen);
  }

  /** Remove a fact. */
  remove(subj: string, pred: string, obj: string): void {
    this.triples = this.triples.filter(t => !(t.subj === subj && t.pred === pred && t.obj === obj));
    this.save();
  }

  /** Search for entities or predicates containing a keyword. */
  search(keyword: string, limit: number = 15): Triple[] {
    const k = keyword.toLowerCase();
    return this.triples.filter(t => t.subj.toLowerCase().includes(k) || t.pred.toLowerCase().includes(k) || t.obj.toLowerCase().includes(k)).slice(-limit);
  }

  /** Format facts as readable text. */
  format(entity?: string): string {
    const facts = entity ? this.about(entity) : this.triples.slice(-30);
    if (facts.length === 0) return "(no facts)";
    const bySubj = new Map<string, string[]>();
    for (const f of facts) {
      if (!bySubj.has(f.subj)) bySubj.set(f.subj, []);
      bySubj.get(f.subj)!.push(`${f.pred} → ${f.obj}`);
    }
    const lines: string[] = [];
    for (const [subj, preds] of bySubj) {
      lines.push(`**${subj}**: ${preds.join(", ")}`);
    }
    return lines.join("\n");
  }

  get size(): number { return this.triples.length; }

  private save(): void {
    try {
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.indexPath, JSON.stringify(this.triples.slice(-2000)), "utf-8");
    } catch (e) { log.warn("kg_save_failed", { error: String(e) }); }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        this.triples = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
      }
    } catch { this.triples = []; }
  }
}

/* ── Auto-extract facts from conversation ── */
const RELATION_PATTERNS: Array<[RegExp, string]> = [
  [/(\w+) (?:是|为|属于|使用|用|用到了|采用) (.+?)(?:[。，,.\n]|$)/g, "is"],
  [/(\w+) (?:版本|version|v) (?:是|为)? ?(\d[\d.]*)/gi, "version"],
  [/(\w+) (?:depends|依赖|需要|requires) (\w+)/gi, "depends_on"],
  [/(\w+) (?:config|配置) (?:为|是)? (.+?)(?:[。，,.\n]|$)/gi, "config"],
  [/(\w+) (?:file|path|文件|路径) (?:在|为|at) (.+?)(?:[。，,.\n]|$)/gi, "located_at"],
];

export function extractFacts(text: string, _agent: string): Array<[string, string, string]> {
  const facts: Array<[string, string, string]> = [];
  for (const [pattern, pred] of RELATION_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const subj = match[1].trim().toLowerCase();
      const obj = match[2].trim();
      if (subj.length >= 2 && obj.length >= 2 && subj !== obj) {
        facts.push([subj, pred, obj]);
      }
    }
  }
  return facts;
}
