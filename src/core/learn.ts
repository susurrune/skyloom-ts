/**
 * 持续学习模块 — post-task review + experience recording.
 *
 * After each task, the agent writes a structured review.
 * Failed attempts are indexed for similarity search to avoid repetition.
 */

import * as fs from "fs";
import * as path from "path";
import { USER_CONFIG_DIR } from "./config";
import { getLogger } from "./logger";

const log = getLogger("learn");

/* ── Data types ── */
export interface TaskReview {
  ts: string;
  agent: string;
  goal: string;
  success: boolean;
  durationMs: number;
  toolCalls: string[];
  errorMsg?: string;
  rootCause?: string;
  improvement?: string;
}

export interface ExperienceEntry {
  id: string;
  pattern: string;       // What went wrong (key for similarity search)
  solution: string;      // What fixed it
  frequency: number;     // How often this pattern repeats
  lastSeen: string;
}

/* ── Persistence ── */
const reviewDir = path.join(USER_CONFIG_DIR, "reviews");
const expFile = path.join(USER_CONFIG_DIR, "experiences.json");
const reviewDir_ = reviewDir; // for closure

function ensureDir() { if (!fs.existsSync(reviewDir_)) fs.mkdirSync(reviewDir_, { recursive: true }); }

/* ═══════════════════════════════════════
   Task Review Recording
   ═══════════════════════════════════════ */
export function recordReview(review: TaskReview): void {
  ensureDir();
  const file = path.join(reviewDir_, `${review.ts.slice(0, 10)}_${review.agent}.jsonl`);
  const line = JSON.stringify(review);
  fs.appendFileSync(file, line + "\n");
  log.debug("review_recorded", { agent: review.agent, success: review.success });

  // If failed, also record as experience
  if (!review.success && review.errorMsg) {
    recordExperience(review.errorMsg, review.rootCause || "unknown", review.improvement || "no improvement noted");
  }
}

/* ═══════════════════════════════════════
   Experience Recording (for failure patterns)
   ═══════════════════════════════════════ */
function loadExperiences(): ExperienceEntry[] {
  try {
    if (fs.existsSync(expFile)) return JSON.parse(fs.readFileSync(expFile, "utf-8"));
  } catch { /* ignore */ }
  return [];
}

function saveExperiences(entries: ExperienceEntry[]): void {
  ensureDir();
  fs.writeFileSync(expFile, JSON.stringify(entries, null, 2), "utf-8");
}

export function recordExperience(errorPattern: string, rootCause: string, solution: string): void {
  const entries = loadExperiences();
  const normalized = errorPattern.toLowerCase().slice(0, 200);

  // Check for existing similar pattern (simple substring match)
  const existing = entries.find(e => e.pattern.toLowerCase().includes(normalized.slice(0, 50)) || normalized.includes(e.pattern.toLowerCase().slice(0, 50)));
  if (existing) {
    existing.frequency++;
    existing.lastSeen = new Date().toISOString();
    if (solution && solution !== "no improvement noted") existing.solution = solution;
  } else {
    entries.push({
      id: Math.random().toString(36).slice(2, 10),
      pattern: errorPattern.slice(0, 200),
      solution,
      frequency: 1,
      lastSeen: new Date().toISOString(),
    });
  }

  // Keep top 100 experiences, sorted by frequency
  entries.sort((a, b) => b.frequency - a.frequency);
  if (entries.length > 100) entries.splice(100);
  saveExperiences(entries);
}

/* ═══════════════════════════════════════
   Query experiences
   ═══════════════════════════════════════ */
export function queryExperiences(problem: string, limit: number = 3): ExperienceEntry[] {
  const entries = loadExperiences();
  const lower = problem.toLowerCase();
  return entries
    .filter(e => {
      const plow = e.pattern.toLowerCase();
      // Simple token overlap scoring
      const tokens = lower.split(/\s+/).filter(t => t.length > 2);
      const matches = tokens.filter(t => plow.includes(t));
      return matches.length >= 2;
    })
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit);
}

/* ═══════════════════════════════════════
   Format experiences for system prompt injection
   ═══════════════════════════════════════ */
export function formatExperiencesForPrompt(problem: string): string {
  const exps = queryExperiences(problem);
  if (!exps.length) return "";
  const lines = ["## 历史教训（从经验库检索）", "以下是与当前任务相关的过往失败案例，请避免重复："];
  for (const e of exps) {
    lines.push(`- **模式**: ${e.pattern.slice(0, 120)}`);
    lines.push(`  **解决**: ${e.solution.slice(0, 200)} (出现 ${e.frequency} 次)`);
  }
  return lines.join("\n");
}

/* ═══════════════════════════════════════
   Generate a structured review after task completion
   ═══════════════════════════════════════ */
export function generateReview(
  agent: string, goal: string, success: boolean, durationMs: number,
  toolCalls: string[], errorMsg?: string
): TaskReview {
  return {
    ts: new Date().toISOString(),
    agent, goal, success, durationMs, toolCalls,
    errorMsg,
    rootCause: errorMsg ? "auto-detected failure" : undefined,
    improvement: errorMsg ? "review error and adjust approach" : undefined,
  };
}
