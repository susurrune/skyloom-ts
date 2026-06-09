/**
 * Anti-loop guard for the agent reasoning loop.
 *
 * Extracted from chatStreamImpl (Phase 3). Holds the per-turn heuristic state
 * (recent response texts, tool-call signatures, tool outcomes + once-only hint
 * flags) and, after each round, returns a decision: zero or more system
 * "hints" to nudge the model, and optionally a hard `stop` (assistant note +
 * a user-visible content line). The agent loop applies the decision — the guard
 * itself has no side effects, which makes every branch unit-testable.
 *
 * A fresh LoopGuard is created per turn (state must not leak across turns).
 */

import type { ToolCall } from '../llm';
import {
  toolCallSignature,
  textSimilarity,
  looksLikeFailedToolResult,
  parseToolArgs,
  SIG_WINDOW,
  SIG_LOOP_HINT,
  SIG_LOOP_HARDSTOP,
} from '../agent_helpers';

/** A hard stop: record `note` as an assistant message, then surface `contentLine`. */
export interface GuardStop {
  note: string;
  contentLine: string;
}

/** The guard's decision for one round. `hints` apply in order; `stop` ends the turn. */
export interface GuardDecision {
  hints: string[];
  stop?: GuardStop;
}

/** Minimal shape of a tool execution result the guard inspects. */
export interface GuardExecResult {
  toolName: string;
  success: boolean;
  result: string;
}

export class LoopGuard {
  private recentResponseTexts: string[] = [];
  private recentToolSigs: string[] = [];
  private recentToolOutcomes: boolean[] = [];
  private searchCount = 0; // cumulative search/fetch calls this turn (not window-bounded)
  private repetitionHintInjected = false;
  private toolLoopHintInjected = false; // shared by tool-signature loop + search-storm
  private stuckHintInjected = false;

  /**
   * Observe one completed round. Mutates internal state and returns the
   * hints/stop decision. Evaluation order (and the shared hint flag) mirrors
   * the original inline logic exactly.
   */
  observe(
    roundContent: string,
    toolCallsReceived: ToolCall[],
    execResults: Array<GuardExecResult | null>
  ): GuardDecision {
    const hints: string[] = [];

    // 1. Narration-loop: response too similar to a recent one.
    const normalizedRound = (roundContent || '').trim();
    if (normalizedRound && this.recentResponseTexts.length > 0) {
      const highSim = this.recentResponseTexts.slice(-2).some(prev => textSimilarity(normalizedRound, prev) >= 0.7);
      if (highSim && !this.repetitionHintInjected) {
        hints.push('[Stop narrating] Your last response is highly similar to your previous one. Stop writing prose. Either: (1) emit ONLY the next tool call, or (2) output the final deliverable.');
        this.repetitionHintInjected = true;
      }
    }
    this.recentResponseTexts.push(normalizedRound);
    if (this.recentResponseTexts.length > 3) this.recentResponseTexts.shift();

    // 2. Tool-signature loop: same call repeated within the window.
    for (const tc of toolCallsReceived) {
      const tName = tc.function.name;
      if (['task_done', 'list_skills', 'use_skill'].includes(tName)) continue;
      if (['web_search', 'fetch_page', 'http_get'].includes(tName)) this.searchCount++;
      const rawArgs = tc.function.arguments;
      const tArgs = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
      const sig = toolCallSignature(tName, tArgs);
      if (sig) this.recentToolSigs.push(sig);
    }
    if (this.recentToolSigs.length > SIG_WINDOW) {
      this.recentToolSigs.splice(0, this.recentToolSigs.length - SIG_WINDOW);
    }
    if (this.recentToolSigs.length > 0) {
      const counts = new Map<string, number>();
      for (const s of this.recentToolSigs) counts.set(s, (counts.get(s) || 0) + 1);
      let topSig = '';
      let topCount = 0;
      for (const [s, c] of counts) { if (c > topCount) { topSig = s; topCount = c; } }
      if (topCount >= SIG_LOOP_HINT && !this.toolLoopHintInjected) {
        hints.push(`[Tool loop] You have called \`${topSig}\` ${topCount}x in the last ${this.recentToolSigs.length} tool calls — you are iterating without converging. STOP repeating it.`);
        this.toolLoopHintInjected = true;
      }
      if (topCount >= SIG_LOOP_HARDSTOP) {
        return { hints, stop: { note: `I have repeated \`${topSig}\` ${topCount} times without converging. Stopping.`, contentLine: `\n\n[stuck] tool \`${topSig}\` repeated ${topCount}x — stopping.` } };
      }
    }

    // 3. Stuck-loop: most/all recent tool calls failed.
    for (const r of execResults) {
      if (!r || r.toolName === 'task_done') continue;
      const failed = !r.success || (typeof r.result === 'string' && looksLikeFailedToolResult(r.result));
      this.recentToolOutcomes.push(!failed);
      // Keep 8 so the "all recent calls failed" (>=8) hard-stop below is reachable.
      if (this.recentToolOutcomes.length > 8) this.recentToolOutcomes.shift();
    }
    if (!this.stuckHintInjected && this.recentToolOutcomes.length >= 5 &&
        this.recentToolOutcomes.filter(Boolean).length <= 1) {
      hints.push('[Recovery hint] Your last several tool calls have mostly failed. Synthesize a partial answer from what worked or ask the user for guidance.');
      this.stuckHintInjected = true;
    }
    if (this.recentToolOutcomes.length >= 8 && this.recentToolOutcomes.every(x => !x)) {
      return { hints, stop: { note: 'Every recent tool call failed. Please give me more context.', contentLine: '\n\n[stuck] every recent tool call failed — stopping.\n' } };
    }

    // 4. Search-storm: cumulative search/fetch calls this turn (not bounded by
    // SIG_WINDOW, so the >=12 hard-stop is actually reachable).
    if (this.searchCount >= 8 && !this.toolLoopHintInjected) {
      hints.push(`[Search storm] ${this.searchCount} search calls. STOP searching and synthesize.`);
      this.toolLoopHintInjected = true;
    }
    if (this.searchCount >= 12) {
      return { hints, stop: { note: 'Too many search requests. Synthesizing best answer.', contentLine: `\n\n[stuck] excessive web searching (${this.searchCount} calls) — stopping.\n` } };
    }

    return { hints };
  }
}
