/**
 * 自我进化模块 — Prompt self-optimization via failure analysis.
 *
 * When an agent repeatedly fails at similar tasks, this module analyzes
 * the failure patterns and suggests targeted improvements to the agent's
 * System Prompt. The agent can then apply these suggestions to improve
 * future performance.
 *
 * Architecture:
 *    Failure log → Pattern analysis → Prompt diff → Agent.applyDiff()
 */

import * as fs from "fs";
import * as path from "path";
import { USER_CONFIG_DIR } from "./config";
import { getLogger } from "./logger";

const log = getLogger("evolve");

/* ═══════════════════════════════════════
   Prompt diff — a suggested change
   ═══════════════════════════════════════ */
export interface PromptDiff {
  id: string;
  ts: string;
  agent: string;
  reason: string;           // Why this change is needed
  before: string;           // Old prompt fragment
  after: string;            // New prompt fragment
  applied: boolean;
  improvement?: string;     // Measured improvement after applying
}

/* ═══════════════════════════════════════
   Failure analysis
   ═══════════════════════════════════════ */
export interface FailureAnalysis {
  agent: string;
  period: string;
  totalCalls: number;
  failureCount: number;
  topFailures: Array<{ pattern: string; count: number }>;
  suggestedDiffs: PromptDiff[];
}

const evolveDir = path.join(USER_CONFIG_DIR, "evolve");
function ensureDir() { if (!fs.existsSync(evolveDir)) fs.mkdirSync(evolveDir, { recursive: true }); }

/** Analyze recent failures from the learning module and suggest prompt improvements. */
export function analyzeFailures(
  agent: string,
  experiences: Array<{ pattern: string; solution: string; frequency: number; lastSeen: string }>,
  systemPrompt: string
): FailureAnalysis {
  const recent = experiences.filter(e => {
    try { return new Date(e.lastSeen).getTime() > Date.now() - 7 * 86400000; }
    catch { return false; }
  });

  const topFailures = recent
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 5)
    .map(e => ({ pattern: e.pattern, count: e.frequency }));

  const suggestedDiffs: PromptDiff[] = [];

  // Rule-based suggestions from failure patterns
  for (const f of topFailures) {
    const lower = f.pattern.toLowerCase();

    // Search storm → add search budget rule
    if ((lower.includes("search") || lower.includes("web_search")) && f.count >= 3) {
      const rule = `- 搜索不超过 5 轮。5 轮后直接基于已有信息综合回答。`;
      if (!systemPrompt.includes("搜索不超过")) {
        suggestedDiffs.push({
          id: Math.random().toString(36).slice(2, 8),
          ts: new Date().toISOString(), agent,
          reason: `搜索风暴 (${f.count} 次重复搜索)`,
          before: "", after: rule, applied: false,
        });
      }
    }

    // Empty response → add deliverable checklist
    if ((lower.includes("empty") || lower.includes("placeholder") || lower.includes("完成了")) && f.count >= 2) {
      const rule = `- 完成任务后，必须输出实际产物（代码/文件路径/数据），禁止只说"完成了"而无产出。`;
      if (!systemPrompt.includes("必须输出实际产物")) {
        suggestedDiffs.push({
          id: Math.random().toString(36).slice(2, 8),
          ts: new Date().toISOString(), agent,
          reason: `空响应/占位 (${f.count} 次)`,
          before: "", after: rule, applied: false,
        });
      }
    }

    // Tool not found → add tool discovery to prompt
    if (lower.includes("does not exist") || lower.includes("tool") && lower.includes("not found")) {
      const rule = `- 使用不熟悉的工具前先调 list_skills 查看可用工具列表。`;
      if (!systemPrompt.includes("list_skills")) {
        suggestedDiffs.push({
          id: Math.random().toString(36).slice(2, 8),
          ts: new Date().toISOString(), agent,
          reason: `工具不存在 (${f.count} 次)`,
          before: "", after: rule, applied: false,
        });
      }
    }

    // File not found → add path verification rule
    if (lower.includes("file not found") || lower.includes("directory not found")) {
      const rule = `- 文件操作前先用 list_directory 或 read_file 确认路径存在。`;
      if (!systemPrompt.includes("确认路径存在")) {
        suggestedDiffs.push({
          id: Math.random().toString(36).slice(2, 8),
          ts: new Date().toISOString(), agent,
          reason: `文件路径错误 (${f.count} 次)`,
          before: "", after: rule, applied: false,
        });
      }
    }
  }

  // Deduplicate suggestions
  const seen = new Set<string>();
  const uniqueDiffs = suggestedDiffs.filter(d => {
    const key = d.after.slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // Max 3 suggestions per analysis
  return {
    agent, period: "last 7 days",
    totalCalls: 0, failureCount: 0,
    topFailures,
    suggestedDiffs: uniqueDiffs.slice(0, 3),
  };
}

/* ═══════════════════════════════════════
   Apply prompt diff to agent
   ═══════════════════════════════════════ */
export function applyPromptDiff(agent: any, diff: PromptDiff): boolean {
  try {
    const currentPrompt = agent.systemPrompt;
    if (!diff.after || currentPrompt.includes(diff.after.slice(0, 20))) return false;

    // Append the new rule after "## 行为守则" or "## Behavior" section
    const marker = currentPrompt.includes("行为守则") ? "## 行为守则" : "## Behavior";
    const idx = currentPrompt.indexOf(marker);
    if (idx < 0) { agent.systemPrompt += "\n" + diff.after; }
    else {
      const insertPoint = currentPrompt.indexOf("\n", currentPrompt.indexOf("\n-", idx) + 1);
      agent.systemPrompt = currentPrompt.slice(0, insertPoint) + "\n" + diff.after + "\n" + currentPrompt.slice(insertPoint);
    }

    diff.applied = true;
    diff.improvement = "pending evaluation";

    // Persist the diff
    ensureDir();
    const file = path.join(evolveDir, `${diff.agent}_diffs.jsonl`);
    fs.appendFileSync(file, JSON.stringify(diff) + "\n");

    agent.rebuildSystemPrompt();
    return true;
  } catch (e) {
    log.warn("apply_prompt_diff_failed", { agent: diff.agent, error: String(e) });
    return false;
  }
}

/** Get all applied diffs for an agent. */
export function getAppliedDiffs(agent: string): PromptDiff[] {
  const diffs: PromptDiff[] = [];
  try {
    const file = path.join(evolveDir, `${agent}_diffs.jsonl`);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) { try { diffs.push(JSON.parse(line)); } catch { } }
    }
  } catch { /* ignore */ }
  return diffs;
}
