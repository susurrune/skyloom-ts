/**
 * 多Agent冲突仲裁 — majority voting, quality scoring, tie-breaking.
 *
 * When multiple agents produce conflicting outputs on the same task
 * (or when a reviewer disagrees with an executor), this module
 * provides structured conflict resolution.
 */

import type { TaskExecutionResult } from "./factory";

/* ═══════════════════════════════════════
   Conflict detection
   ═══════════════════════════════════════ */
export interface Conflict {
  taskId: string;
  results: TaskExecutionResult[];
  description: string;
  severity: "low" | "medium" | "high";
}

/** Detect if two results conflict based on success status and content overlap. */
export function detectConflicts(results: TaskExecutionResult[]): Conflict[] {
  const byTask = new Map<string, TaskExecutionResult[]>();
  for (const r of results) { const id = r.id; if (!byTask.has(id)) byTask.set(id, []); byTask.get(id)!.push(r); }

  const conflicts: Conflict[] = [];
  for (const [id, items] of byTask) {
    if (items.length < 2) continue;

    const successes = items.filter(r => r.success);
    const failures = items.filter(r => !r.success);

    // All succeeded — check content divergence
    if (successes.length >= 2) {
      const contents = successes.map(r => (r.content || "").toLowerCase());
      const similarity = pairwiseSimilarity(contents);
      if (similarity < 0.3) {
        conflicts.push({ taskId: id, results: successes, description: "Multiple agents produced divergent successful outputs", severity: "medium" });
      }
    }

    // Mix of success and failure
    if (successes.length > 0 && failures.length > 0) {
      conflicts.push({ taskId: id, results: items, description: `${successes.length} succeeded, ${failures.length} failed — need tiebreaker`, severity: "medium" });
    }

    // All failed
    if (failures.length >= 2 && successes.length === 0) {
      conflicts.push({ taskId: id, results: failures, description: "All agents failed on this task", severity: "high" });
    }
  }

  return conflicts;
}

/* ═══════════════════════════════════════
   Content similarity (n-gram Jaccard)
   ═══════════════════════════════════════ */
function pairwiseSimilarity(texts: string[]): number {
  if (texts.length < 2) return 1.0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      total += ngramJaccard(texts[i], texts[j], 3);
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

function ngramJaccard(a: string, b: string, n: number): number {
  const as = ngrams(a, n), bs = ngrams(b, n);
  if (as.size === 0 && bs.size === 0) return 1;
  let intersection = 0;
  for (const g of as) { if (bs.has(g)) intersection++; }
  const union = as.size + bs.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function ngrams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

/* ═══════════════════════════════════════
   Majority voting / arbitration
   ═══════════════════════════════════════ */
export interface ArbitrationResult {
  winner: TaskExecutionResult;
  method: "unanimous" | "majority" | "tiebreaker" | "single";
  confidence: number; // 0-1
  reasoning: string;
}

/** Pick the best result from conflicting ones via majority vote. */
export function arbitrate(results: TaskExecutionResult[]): ArbitrationResult {
  if (results.length === 0) throw new Error("No results to arbitrate");
  if (results.length === 1) return { winner: results[0], method: "single", confidence: 0.8, reasoning: "Only one result available" };

  const success = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);

  // All agree (success)
  if (success.length === results.length) {
    const longest = success.reduce((a, b) => (b.content || "").length > (a.content || "").length ? b : a);
    return { winner: longest, method: "unanimous", confidence: 0.95, reasoning: `${results.length}/${results.length} agents agreed` };
  }

  // Majority success
  if (success.length > fail.length) {
    // Pick the longest successful content (most detailed)
    const best = success.reduce((a, b) => (b.content || "").length > (a.content || "").length ? b : a);
    return { winner: best, method: "majority", confidence: success.length / results.length, reasoning: `${success.length}/${results.length} succeeded, selected most detailed` };
  }

  // Majority failure — pick the "closest to success" (longest content)
  if (fail.length > success.length) {
    const best = fail.reduce((a, b) => (b.content || "").length > (a.content || "").length ? b : a);
    return { winner: best, method: "majority", confidence: 0.3, reasoning: `Majority failed (${fail.length}/${results.length}), best-effort from partial output` };
  }

  // Tie — prefer success, or longest content
  const tie = success.length > 0 ? success[0] : fail[0];
  return { winner: tie, method: "tiebreaker", confidence: 0.5, reasoning: `Tie — selected ${tie.success ? "success" : "longest"} result` };
}

/* ═══════════════════════════════════════
   Quality scoring for individual results
   ═══════════════════════════════════════ */
export interface QualityScore {
  score: number;         // 0-100
  completeness: number;  // how much of the task was addressed
  richness: number;      // detail level of the output
  correctness: number;   // did it match expectations (requires ground truth)
}

export function scoreQuality(result: TaskExecutionResult): QualityScore {
  const content = result.content || "";

  // Completeness: length is a weak proxy but useful
  const completeness = content.length > 500 ? 80 : content.length > 100 ? 50 : content.length > 0 ? 20 : 0;

  // Richness: code blocks, structured output, bullet points
  let richness = 50;
  if (/```/.test(content)) richness += 20;
  if (/\|.*\|.*\|/.test(content)) richness += 15; // tables
  if (/^[-*] /.test(content)) richness += 10;      // bullets
  if (/\d+\./.test(content)) richness += 10;        // numbered lists
  richness = Math.min(100, richness);

  // Correctness: basic sanity checks
  let correctness = 70;
  if (content.includes("Error") || content.includes("error")) correctness -= 20;
  if (content.includes("[REDACTED]")) correctness -= 10;
  if (content.includes("truncated")) correctness -= 15;
  correctness = Math.max(0, correctness);

  const score = Math.round((completeness * 0.3 + richness * 0.3 + correctness * 0.4));
  return { score, completeness, richness, correctness };
}
