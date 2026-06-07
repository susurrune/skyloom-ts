/**
 * Shared constants across the Skyloom framework.
 * Central home for values that cross module boundaries — keeps
 * circular imports in check and avoids duplication.
 */

/**
 * Sentinel returned by the task_done tool. When the LLM calls
 * task_done, the chat-stream loop detects this value in the tool
 * result and terminates the turn cleanly (no truncation warning).
 */
export const TASK_DONE_SENTINEL = "__TASK_DONE__";

/**
 * Valid agent names in the system
 */
export const VALID_AGENTS = Object.freeze({
  fog: "fog",
  rain: "rain",
  frost: "frost",
  snow: "snow",
  dew: "dew",
  fair: "fair",
} as const);

/**
 * Agent type union
 */
export type AgentType = keyof typeof VALID_AGENTS;

/**
 * Agent roles and descriptions
 */
export const AGENT_DESCRIPTIONS: Record<AgentType, string> = {
  fog: "Research & Analysis — explore, investigate, analyze",
  rain: "Code Generation — create, implement, generate",
  frost: "Review & Optimization — critique, optimize, verify",
  snow: "Planning & Orchestration — plan, decompose, coordinate",
  dew: "DevOps & Execution — operate, deploy, execute",
  fair: "Emotional Companion — comfort, encourage, advise",
};

/**
 * Default tool timeout in milliseconds
 */
export const DEFAULT_TOOL_TIMEOUT = 30000; // 30 seconds

/**
 * Maximum retries for tool execution
 */
export const MAX_TOOL_RETRIES = 3;

/**
 * Memory layer configuration
 */
export const MEMORY_LAYERS = Object.freeze({
  SHORT_TERM: "short_term",
  WORKING: "working",
  LONG_TERM: "long_term",
} as const);

/**
 * Response types
 */
export const RESPONSE_TYPES = Object.freeze({
  TEXT: "text",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  ERROR: "error",
} as const);

/**
 * Log levels
 */
export const LOG_LEVELS = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const);

/**
 * Maximum context window (tokens)
 */
export const MAX_CONTEXT_TOKENS = 100000;

/**
 * Routing modes for CLI
 */
export const ROUTING_MODES = Object.freeze({
  DIRECT: "direct",
  SINGLE: "single",
  ORCHESTRATE: "orchestrate",
  AUTO: "auto",
} as const);
