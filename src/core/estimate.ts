/**
 * 资源估算模块 — Token & time budget estimation for task planning.
 *
 * Helps Snow and other planning agents estimate the cost of
 * proposed sub-tasks before committing to execution.
 */

import type { Task } from "./agent";

/* ═══════════════════════════════════════
   Token estimation
   ═══════════════════════════════════════ */
const CJK_REGEX = /[一-鿿぀-ゟ가-힯㐀-䶿]/g;

/** Estimate tokens for a given text (CJK ~2 each, ASCII ~4 chars each). */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_REGEX) || []).length;
  return cjk * 2 + Math.ceil((text.length - cjk) / 4);
}

/* ═══════════════════════════════════════
   Per-task-type cost estimates
   ═══════════════════════════════════════ */
const TASK_TYPE_PATTERNS: Array<[RegExp, number, number]> = [
  // [pattern, estimated tokens, estimated tools]
  [/read|read_file|grep|search|查|搜索|list/i, 2000, 2],
  [/write|write_file|生成|写|create|implement/i, 4000, 5],
  [/edit|edit_file|改|修改|fix|修复/i, 3000, 3],
  [/delete|delete_file|删|rm/i, 1500, 2],
  [/deploy|部署|publish|发布|release/i, 8000, 8],
  [/review|审查|audit|审计|scan|扫描/i, 5000, 4],
  [/test|测试|run_test|coverage/i, 3000, 3],
  [/research|研究|调研|analyze|分析/i, 6000, 4],
  [/orchestrate|编排|multi-step|多步/i, 12000, 10],
];

/** Estimate cost for a single task description. */
export function estimateTaskCost(description: string): { tokens: number; tools: number; timeSeconds: number } {
  let tokens = 2000; // base
  let tools = 2;     // base
  for (const [pattern, t, tc] of TASK_TYPE_PATTERNS) {
    if (pattern.test(description)) { tokens = Math.max(tokens, t); tools = Math.max(tools, tc); }
  }

  // Time estimate: ~0.5s per tool call + 2s per 1k tokens
  const timeSeconds = (tokens / 1000) * 2 + tools * 0.5 + 2;
  return { tokens, tools, timeSeconds };
}

/* ═══════════════════════════════════════
   Task plan cost summary
   ═══════════════════════════════════════ */
export interface PlanEstimate {
  totalTokens: number;
  totalTools: number;
  totalTimeSeconds: number;
  perTask: Array<{ id: string; tokens: number; tools: number; time: number }>;
  warnings: string[];
}

export function estimateTaskPlan(tasks: Task[]): PlanEstimate {
  const perTask: PlanEstimate["perTask"] = [];
  let totalTokens = 500; // system prompt overhead
  let totalTools = 0;
  let totalTime = 5; // init overhead
  const warnings: string[] = [];

  for (const t of tasks) {
    const est = estimateTaskCost(t.description);
    perTask.push({ id: t.id, tokens: est.tokens, tools: est.tools, time: est.timeSeconds });
    totalTokens += est.tokens;
    totalTools += est.tools;
    totalTime += est.timeSeconds;

    if (est.timeSeconds > 60) warnings.push(`Task ${t.id} may take >${Math.round(est.timeSeconds)}s`);
    if (est.tools > 10) warnings.push(`Task ${t.id} uses many tool calls (${est.tools})`);
  }

  if (totalTokens > 64000) warnings.push(`Total token estimate (${totalTokens}) exceeds typical context window`);
  if (totalTime > 120) warnings.push(`Estimated total time (${Math.round(totalTime)}s) is significant`);
  if (tasks.length > 6) warnings.push(`Large number of sub-tasks (${tasks.length}) — consider merging simpler ones`);

  return { totalTokens, totalTools, totalTimeSeconds: Math.round(totalTime), perTask, warnings };
}

/* ═══════════════════════════════════════
   Format estimate for display
   ═══════════════════════════════════════ */
export function formatPlanEstimate(est: PlanEstimate): string {
  const lines: string[] = [
    `## Plan Estimate`,
    `| Task | Tokens | Tools | Time |`,
    `|------|--------|-------|------|`,
    ...est.perTask.map(t => `| ${t.id} | ${t.tokens} | ${t.tools} | ${t.time.toFixed(0)}s |`),
    `| **Total** | **${est.totalTokens}** | **${est.totalTools}** | **${est.totalTimeSeconds}s** |`,
  ];

  if (est.warnings.length > 0) {
    lines.push("", "### Warnings");
    for (const w of est.warnings) lines.push(`- ⚠ ${w}`);
  }

  return lines.join("\n");
}
