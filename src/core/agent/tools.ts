import { Event, EventType, type MessageBus } from '../bus';
import type { ToolCall } from '../llm';
import { safeStableStringify, type ToolDefinition, type ToolRegistry } from '../tool';
import {
  formatArgsParseError,
  parseToolArgs,
  suggestToolNames,
  toolStatusLabel,
} from '../agent_helpers';
import { mapBounded, resolveConcurrency } from '../concurrency';
import { runPostToolHooks, runPreToolHooks, type Hooks } from '../hooks';
import type { Tracer } from '../trace';

const WRITE_TOOL_RE = /^(write_|edit_|delete_|create_)|^run_bash$|^git_commit$|^apply_patch$/;
const TOOL_RESULT_LIMIT = 12000;

type ToolArgs = Record<string, unknown>;

interface ToolExecutorConfig {
  llm?: {
    tool_concurrency?: unknown;
    tool_result_limit?: unknown;
  };
}

function argsPreview(args: ToolArgs | null | undefined): string {
  if (!args) return '';
  try {
    return JSON.stringify(args).replace(/\s+/g, ' ').slice(0, 80);
  } catch {
    return '';
  }
}

export function clampToolResult(s: string, limit: number = TOOL_RESULT_LIMIT): string {
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.floor(limit * 0.72));
  const tail = s.slice(-Math.floor(limit * 0.18));
  const cut = s.length - head.length - tail.length;
  return `${head}\n…[工具结果过长，中间省略 ${cut} 字符 — 需要该部分时用更精确的参数重新调用（read_file 的 offset/limit、grep 定位、缩小查询范围）]\n${tail}`;
}

export interface ToolExecutionResult {
  tc: ToolCall;
  result: string;
  success: boolean;
  toolName: string;
}

export interface ToolCallExecutorOptions {
  dedupCacheable?: boolean;
  onStatus?: (label: string) => void;
  suppressedTools?: Set<string>;
  ephemeral?: boolean;
  signal?: AbortSignal;
}

export interface ToolCallExecutorDeps {
  agentName: string;
  config: ToolExecutorConfig;
  bus: MessageBus;
  registry: ToolRegistry;
  tracer: Tracer;
  approve: (toolName: string, args: ToolArgs) => Promise<boolean>;
  setActing: () => Promise<void>;
  getHooks: () => Hooks;
  markFilesWritten: () => void;
  addToolMessage: (content: string, metadata: { name: string; toolCallId: string; ephemeral: boolean }) => void;
}

interface PreparedCall {
  tc: ToolCall;
  toolName: string;
  toolArgs: ToolArgs | null;
  tool: ToolDefinition | undefined;
  parseError: string | null;
  label: string;
  denied: boolean;
}

/** Shared parse, approval, execution, tracing, and recording pipeline for one tool round. */
export class ToolCallExecutor {
  constructor(private readonly deps: ToolCallExecutorDeps) {}

  async execute(toolCalls: ToolCall[], options: ToolCallExecutorOptions = {}): Promise<ToolExecutionResult[]> {
    const { agentName, bus, config, registry, tracer } = this.deps;
    const { suppressedTools: suppressed, signal, onStatus } = options;
    const ephemeral = options.ephemeral ?? false;

    const parsed: PreparedCall[] = toolCalls.map((tc) => {
      const toolName = tc.function.name;
      const rawArgs = tc.function.arguments;
      let toolArgs: ToolArgs | null = null;
      let parseError: string | null = null;

      if (typeof rawArgs === 'string') {
        toolArgs = parseToolArgs(rawArgs);
        if (toolArgs === null) parseError = formatArgsParseError(toolName, rawArgs);
      } else {
        toolArgs = rawArgs;
      }

      bus.addEvent(new Event(EventType.TOOL_CALL, agentName, null, {
        tool: toolName,
        args: toolArgs || {},
      }));

      const tool = registry.get(toolName);
      const label = toolArgs ? toolStatusLabel(toolName, toolArgs) : `${toolName} (unparseable args)`;
      return { tc, toolName, toolArgs, tool, parseError, label, denied: false };
    });

    // The central danger map, rather than the optional tool hint, owns policy.
    for (const call of parsed.filter((item) => item.tool && !item.parseError)) {
      if (!await this.deps.approve(call.toolName, call.toolArgs || {})) call.denied = true;
    }

    const execPlan: Array<{ idx: number; prep: PreparedCall; isDuplicate: boolean }> = [];
    const seenDedupKeys = new Map<string, number>();
    for (let idx = 0; idx < parsed.length; idx++) {
      const prep = parsed[idx];
      const tool = prep.tool;
      if (options.dedupCacheable && prep.toolArgs && tool && (tool.idempotent || tool.cacheable) && !tool.dangerous) {
        const serialized = safeStableStringify(prep.toolArgs);
        if (serialized === undefined) {
          execPlan.push({ idx, prep, isDuplicate: false });
          continue;
        }
        const key = `${prep.toolName}:${serialized}`;
        if (seenDedupKeys.has(key)) {
          execPlan.push({ idx, prep, isDuplicate: true });
          continue;
        }
        seenDedupKeys.set(key, idx);
      }
      execPlan.push({ idx, prep, isDuplicate: false });
    }

    const results = new Array<ToolExecutionResult | null>(parsed.length).fill(null);
    const uniquePlan = execPlan.filter((entry) => !entry.isDuplicate);
    if (uniquePlan.some(({ prep }) => prep.tool && !prep.parseError && !prep.denied)) {
      await this.deps.setActing();
    }

    const completed = await mapBounded(
      uniquePlan,
      async ({ idx, prep }, _workerIndex, aborted) => {
        if (aborted) {
          return { idx, result: this.result(prep, `[cancelled] '${prep.toolName}' skipped — interrupted before execution`, false) };
        }
        if (prep.parseError) return { idx, result: this.result(prep, prep.parseError, false) };
        if (prep.denied) return { idx, result: this.result(prep, `[denied] tool '${prep.toolName}' blocked by approval policy`, false) };
        if (!prep.tool) {
          suppressed?.add(prep.toolName);
          const suggestions = suggestToolNames(prep.toolName, registry);
          const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
          return { idx, result: this.result(prep, `Error: Tool '${prep.toolName}' does not exist.${hint}`, false) };
        }

        onStatus?.(prep.label);
        this.snapshotFile(prep);

        const hooks = this.deps.getHooks();
        if (hooks.preTool.length > 0) {
          try {
            const pre = runPreToolHooks(hooks, prep.toolName, prep.toolArgs || {}, agentName);
            if (!pre.allowed) {
              return { idx, result: this.result(prep, `[blocked by pre_tool hook] ${pre.reason}`, false) };
            }
          } catch {
            // Hook machinery is best-effort and must not break tool execution.
          }
        }

        const span = tracer.startSpan(prep.toolName, 'tool', { args: argsPreview(prep.toolArgs) }, { leaf: true });
        try {
          const toolResult = await registry.execute(prep.toolName, prep.toolArgs || {}, { signal });
          const resultStr = toolResult.result || toolResult.error || '(no output)';
          if (toolResult.success && WRITE_TOOL_RE.test(prep.toolName)) this.deps.markFilesWritten();
          if (hooks.postTool.length > 0) {
            try {
              runPostToolHooks(hooks, prep.toolName, prep.toolArgs || {}, agentName);
            } catch {
              // Post hooks are best-effort.
            }
          }
          span.end(toolResult.success ? 'ok' : 'error', toolResult.success ? undefined : {
            error: (toolResult.error || resultStr).slice(0, 120),
          });
          return { idx, result: this.result(prep, resultStr, toolResult.success) };
        } catch (error) {
          span.end('error', { error: String(error).slice(0, 120) });
          return { idx, result: this.result(prep, `Tool '${prep.toolName}' execution failed: ${error}`, false) };
        }
      },
      { concurrency: resolveConcurrency(config?.llm?.tool_concurrency), signal },
    );

    for (const { idx, result } of completed) results[idx] = result;
    for (const entry of execPlan) {
      if (!entry.isDuplicate || !entry.prep.toolArgs) continue;
      const serialized = safeStableStringify(entry.prep.toolArgs);
      if (serialized === undefined) continue;
      const originalIdx = seenDedupKeys.get(`${entry.prep.toolName}:${serialized}`);
      if (originalIdx !== undefined && results[originalIdx]) {
        results[entry.idx] = { ...results[originalIdx]!, tc: entry.prep.tc };
      }
    }

    const resultLimit = Number(config?.llm?.tool_result_limit) || undefined;
    for (const result of results) {
      if (!result) continue;
      if (result.result.includes('[CircuitBreakerOpen]')) suppressed?.add(result.toolName);
      this.deps.addToolMessage(clampToolResult(result.result, resultLimit), {
        name: result.toolName,
        toolCallId: result.tc.id,
        ephemeral,
      });
    }

    return results.filter((result): result is ToolExecutionResult => result !== null);
  }

  private result(prep: PreparedCall, result: string, success: boolean): ToolExecutionResult {
    return { tc: prep.tc, result, success, toolName: prep.toolName };
  }

  private snapshotFile(prep: PreparedCall): void {
    try {
      const { getFileCheckpoints } = require('../file_checkpoint');
      const checkpoints = getFileCheckpoints();
      const snapshotPath = checkpoints.pathToSnapshot(prep.toolName, prep.toolArgs || {});
      if (snapshotPath) checkpoints.snapshot(snapshotPath);
    } catch {
      // Checkpointing must never block execution.
    }
  }
}
