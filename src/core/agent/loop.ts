import { Event, EventType, type MessageBus } from '../bus';
import { TASK_DONE_SENTINEL } from '../constants';
import type { LLMClient, LLMResponse, ToolCall, UsageStats } from '../llm';
import { getLogger } from '../logger';
import type { Memory } from '../memory';
import type { Skill } from '../skill';
import type { ToolRegistry } from '../tool';
import { parseToolArgs, synthesizeDelegationSummary, toolStatusLabel } from '../agent_helpers';
import { selectRelevantTools } from '../tool_router';
import type { Tracer } from '../trace';
import { LoopGuard } from './guard';
import { AgentState } from './task';
import type { ToolCallExecutorOptions, ToolExecutionResult } from './tools';

const log = getLogger('agent');
const SIDE_EFFECT_TOOL_RE = /^(write_|edit_|delete_|create_|kill_|launch_|service_|browser_)|^run_bash$|^git_commit$|^open_path$|^delegate_to$|^apply_patch$/;

export interface AgentLoopDeps {
  name: string;
  llm: LLMClient;
  bus: MessageBus;
  memory: Memory;
  toolRegistry: ToolRegistry;
  tracer: Tracer;
  getActiveSkills: () => ReadonlySet<string>;
  getSkills: () => readonly Skill[];
  activeToolNames: () => string[];
  getSkillConfigOverrides: () => Record<string, unknown>;
  executeToolCalls: (toolCalls: ToolCall[], options?: ToolCallExecutorOptions) => Promise<ToolExecutionResult[]>;
  setState: (state: AgentState) => Promise<void>;
  maybeExtractFacts: () => void;
  messagesWithRecall: () => Promise<Record<string, unknown>[]>;
  popLastUserMessage: () => void;
  shouldAutoCompact: () => boolean;
  compact: () => Promise<string>;
  resolveModelId: () => string;
  getPlanMode: () => boolean;
  maxToolRoundsHardCap: number;
  maxNoProgressRounds: number;
}

export interface BatchLoopOptions {
  onStatus?: ((status: string) => void) | null;
  ephemeral?: boolean;
  signal?: AbortSignal;
}

/** Owns the streaming and batch LLM/tool loops while BaseAgent owns lifecycle. */
export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async *runStream(
    message: string,
    autoActivated?: string[],
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    const deps = this.deps;
    await deps.setState(AgentState.THINKING);
    const userMessage = deps.getPlanMode()
      ? `[计划模式] 只读调研，不要执行任何修改。请输出一份编号的执行计划（涉及哪些文件、每步做什么、风险点），等待用户批准后再实施。\n\n${message}`
      : message;
    deps.memory.addMessage('user', userMessage);
    try {
      require('../file_checkpoint').getFileCheckpoints().beginTurn(message);
    } catch { /* optional */ }
    let assistantStored = false;

    if (deps.shouldAutoCompact()) {
      try { await deps.compact(); } catch (error) { log.warn('auto_compact_failed', { error: String(error) }); }
    }

    const delegations: Array<[string, boolean]> = [];
    const suppressedTools = new Set<string>();
    if (autoActivated && autoActivated.length > 0) {
      suppressedTools.add('list_skills');
      deps.memory.addMessage('system',
        '[Auto-activated skills: ' + autoActivated.join(', ') +
        '] These were chosen from your message\'s keywords. Do NOT call list_skills.');
    }

    const guard = new LoopGuard();
    let toolNamesCache: string[] | null = null;
    let cacheKey: string | null = null;
    const resolveToolNames = (): string[] => {
      const activeSkills = deps.getActiveSkills();
      const key = JSON.stringify([[...suppressedTools].sort(), [...activeSkills].sort(), deps.getPlanMode()]);
      if (toolNamesCache !== null && cacheKey === key) return toolNamesCache;
      let candidates = deps.activeToolNames().filter((tool) => !suppressedTools.has(tool));
      if (deps.getPlanMode()) {
        candidates = candidates.filter((name) => {
          if (SIDE_EFFECT_TOOL_RE.test(name)) return false;
          return !deps.toolRegistry.get(name)?.dangerous;
        });
      }
      const must = new Set<string>();
      for (const skill of deps.getSkills()) {
        if (activeSkills.has(skill.name)) {
          for (const tool of skill.requiredTools) must.add(tool);
        }
      }
      toolNamesCache = selectRelevantTools(deps.toolRegistry, candidates, message, { mustInclude: must });
      cacheKey = key;
      return toolNamesCache;
    };

    try {
      let fullContent = '';
      let roundCount = 0;
      let consecutiveNoProgress = 0;

      while (true) {
        if (signal?.aborted) {
          if (!assistantStored && fullContent.trim()) {
            deps.memory.addMessage('assistant', fullContent);
            assistantStored = true;
          } else if (!assistantStored) {
            deps.popLastUserMessage();
          }
          await deps.setState(AgentState.IDLE);
          yield { type: 'interrupted' };
          yield { type: 'done' };
          return;
        }
        if (roundCount >= deps.maxToolRoundsHardCap) break;
        roundCount++;

        const messages = await deps.messagesWithRecall();
        const toolNames = resolveToolNames();
        const toolCallsReceived: ToolCall[] = [];
        let streamingReasoning: string | undefined;
        let streamUsage: (UsageStats & {
          prompt_tokens?: number;
          completion_tokens?: number;
          cost?: number;
        }) | null = null;
        let roundContent = '';

        const llmSpan = deps.tracer.startSpan('chat', 'llm', { model: deps.resolveModelId(), round: roundCount });
        for await (const event of deps.llm.streamWithTools(
          messages,
          deps.name,
          toolNames.length > 0 ? toolNames : undefined,
          toolNames.length > 0 ? deps.toolRegistry : undefined,
          Object.keys(deps.getSkillConfigOverrides()).length > 0 ? deps.getSkillConfigOverrides() : undefined,
          signal,
        )) {
          if (event.type === 'content') {
            fullContent += event.text;
            roundContent += event.text;
            yield { type: 'content', text: event.text };
          } else if (event.type === 'tool_call' && event.toolCall) {
            toolCallsReceived.push(event.toolCall);
          } else if (event.type === 'error') {
            llmSpan.end('error', { error: String(event.text).slice(0, 120) });
            yield { type: 'content', text: `\n[Error: ${event.text}]` };
            if (!assistantStored) deps.popLastUserMessage();
            await deps.setState(AgentState.IDLE);
            return;
          } else if (event.type === 'reasoning' && event.text) {
            yield { type: 'reasoning', text: event.text };
          } else if (event.type === 'done') {
            streamUsage = event.usage || null;
            streamingReasoning = event.reasoningContent;
          }
        }
        llmSpan.end('ok', streamUsage ? {
          promptTokens: streamUsage.promptTokens ?? streamUsage.prompt_tokens,
          completionTokens: streamUsage.completionTokens ?? streamUsage.completion_tokens,
          cost: streamUsage.cost,
          toolCalls: toolCallsReceived.length,
        } : { toolCalls: toolCallsReceived.length });

        if (toolCallsReceived.length === 0) {
          let finalContent = roundContent;
          if (!fullContent.trim() && delegations.length > 0) finalContent = synthesizeDelegationSummary(delegations);
          deps.memory.addMessage('assistant', finalContent, { reasoningContent: streamingReasoning });
          assistantStored = true;
          await deps.setState(AgentState.IDLE);
          deps.maybeExtractFacts();
          if (finalContent !== roundContent) yield { type: 'content', text: finalContent };
          yield { type: 'done' };
          return;
        }

        deps.memory.addMessage('assistant', roundContent, {
          toolCalls: toolCallsReceived,
          reasoningContent: streamingReasoning,
        });
        assistantStored = true;
        if (streamUsage) {
          deps.bus.addEvent(new Event(EventType.LLM_CALL, deps.name, null, { model: '', usage: streamUsage }));
        }

        for (const toolCall of toolCallsReceived) {
          const toolName = toolCall.function.name;
          const rawArgs = toolCall.function.arguments;
          const toolArgs = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
          const label = toolArgs ? toolStatusLabel(toolName, toolArgs) : `${toolName} (unparseable args)`;
          yield { type: 'tool_status', label, tool_name: toolName, tool_call_id: toolCall.id, args: toolArgs || {} };
        }

        const execResults = await deps.executeToolCalls(toolCallsReceived, {
          dedupCacheable: true,
          suppressedTools,
          signal,
        });

        let taskCompleted = false;
        for (const result of execResults) {
          if (result.toolName === 'task_done' && result.result === TASK_DONE_SENTINEL) {
            taskCompleted = true;
            const toolCall = toolCallsReceived.find((item) => item.id === result.tc.id);
            const rawArgs = toolCall?.function?.arguments;
            const args = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
            const summary = (args?.summary as string) || '';
            const displayResult = summary ? `[Task completed: ${summary}]` : '[Task completed]';
            deps.memory.addMessage('tool', displayResult, { name: result.toolName, toolCallId: result.tc.id });
            yield { type: 'tool_done', label: `task_done: ${summary}` || 'task_done', success: true, tool_name: 'task_done', tool_call_id: result.tc.id, result: displayResult };
            continue;
          }

          const toolCall = toolCallsReceived.find((item) => item.id === result.tc.id);
          const rawArgs = toolCall?.function?.arguments;
          const args = typeof rawArgs === 'string' ? parseToolArgs(rawArgs) : rawArgs;
          const label = args ? toolStatusLabel(result.toolName, args) : result.toolName;
          yield {
            type: 'tool_done',
            label,
            success: result.success,
            tool_name: result.toolName,
            tool_call_id: result.tc.id,
            result: (result.result || '').slice(0, 800),
          };
          if (result.toolName === 'delegate_to') {
            delegations.push([(args?.agent as string) || '?', result.success]);
          }
        }

        if (taskCompleted) {
          if (!assistantStored) deps.popLastUserMessage();
          await deps.setState(AgentState.IDLE);
          yield { type: 'done' };
          return;
        }

        const decision = guard.observe(roundContent, toolCallsReceived, execResults);
        for (const hint of decision.hints) deps.memory.addMessage('system', hint);
        if (decision.stop) {
          deps.memory.addMessage('assistant', decision.stop.note);
          yield { type: 'content', text: decision.stop.contentLine };
          await deps.setState(AgentState.IDLE);
          yield { type: 'done' };
          return;
        }

        const madeProgress =
          execResults.some((result) => result.success && result.toolName !== 'task_done') ||
          roundContent.trim().length > 0;
        if (madeProgress) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
          if (consecutiveNoProgress === deps.maxNoProgressRounds - 1) {
            deps.memory.addMessage('system',
              '[No progress] Your recent rounds produced no successful tool result and no text. Either take a concrete next action, output the final answer, or call task_done. One more empty round will end the turn.');
          }
          if (consecutiveNoProgress >= deps.maxNoProgressRounds) {
            if (!assistantStored && fullContent.trim()) {
              deps.memory.addMessage('assistant', fullContent);
              assistantStored = true;
            }
            await deps.setState(AgentState.IDLE);
            yield { type: 'content', text: `\n\n[stalled] ${consecutiveNoProgress} rounds without progress — stopping.` };
            yield { type: 'done' };
            return;
          }
        }
      }

      if (!assistantStored) deps.popLastUserMessage();
      await deps.setState(AgentState.IDLE);
      if (!fullContent.trim() && delegations.length > 0) {
        const summary = synthesizeDelegationSummary(delegations);
        deps.memory.addMessage('assistant', summary);
        yield { type: 'content', text: summary };
      }
      yield {
        type: 'truncated',
        reason: `safety ceiling of ${deps.maxToolRoundsHardCap} tool rounds reached — the task may be unfinished. Send "continue" to resume, or raise llm.max_tool_rounds_hard_cap in config.`,
      };
      yield { type: 'done' };
    } catch (error) {
      if (!assistantStored) deps.popLastUserMessage();
      await deps.setState(AgentState.ERROR);
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'content', text: `\n[Error: ${message}]` };
    } finally {
      deps.memory.pruneToolMessages();
    }
  }

  async runBatch(options: BatchLoopOptions = {}): Promise<LLMResponse> {
    const deps = this.deps;
    const ephemeral = options.ephemeral ?? false;
    const onStatus = options.onStatus ?? null;
    const signal = options.signal;
    let response: LLMResponse = {
      content: '',
      toolCalls: [],
      model: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      cost: 0,
      truncated: false,
    };

    const lastUser = [...deps.memory.shortTerm].reverse().find((message) => message.role === 'user');
    const must = new Set<string>();
    for (const skill of deps.getSkills()) {
      if (deps.getActiveSkills().has(skill.name)) {
        for (const tool of skill.requiredTools) must.add(tool);
      }
    }
    const toolNames = selectRelevantTools(
      deps.toolRegistry,
      deps.activeToolNames(),
      lastUser?.content || '',
      { mustInclude: must },
    );

    try {
      let rounds = 0;
      let consecutiveNoProgress = 0;
      while (true) {
        signal?.throwIfAborted();
        if (rounds >= deps.maxToolRoundsHardCap) break;
        rounds++;
        const messages = await deps.messagesWithRecall();
        onStatus?.('thinking...');
        const llmSpan = deps.tracer.startSpan('complete', 'llm', { model: deps.resolveModelId(), round: rounds });
        try {
          response = await deps.llm.complete(
            messages,
            deps.name,
            toolNames.length > 0 ? toolNames : undefined,
            false,
            Object.keys(deps.getSkillConfigOverrides()).length > 0 ? deps.getSkillConfigOverrides() : undefined,
            signal,
          );
          llmSpan.end('ok', {
            model: response.model,
            promptTokens: response.usage?.promptTokens,
            completionTokens: response.usage?.completionTokens,
            cost: response.cost,
            toolCalls: response.toolCalls?.length || 0,
          });
        } catch (error) {
          llmSpan.end('error', { error: String(error).slice(0, 120) });
          throw error;
        }
        if (!response.toolCalls || response.toolCalls.length === 0) return response;

        deps.bus.addEvent(new Event(EventType.LLM_CALL, deps.name, null, {
          model: response.model,
          usage: response.usage,
        }));
        deps.memory.addMessage('assistant', response.content || '', {
          toolCalls: response.toolCalls,
          reasoningContent: response.reasoningContent,
          ephemeral,
        });
        const execResults = await deps.executeToolCalls(response.toolCalls, {
          dedupCacheable: true,
          onStatus: onStatus ?? undefined,
          ephemeral,
          signal,
        });
        signal?.throwIfAborted();
        await deps.setState(AgentState.THINKING);

        const madeProgress =
          execResults.some((result) => result.success && result.toolName !== 'task_done') ||
          (response.content || '').trim().length > 0;
        consecutiveNoProgress = madeProgress ? 0 : consecutiveNoProgress + 1;
        if (consecutiveNoProgress >= deps.maxNoProgressRounds) break;
      }

      response.truncated = true;
      if (!response.content) {
        response.content = `[stopped] no progress for ${deps.maxNoProgressRounds} rounds (or backstop reached).`;
      }
      return response;
    } catch (error) {
      deps.memory.pruneToolMessages();
      throw error;
    }
  }
}
