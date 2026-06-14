/**
 * spawn_agent tool — launch a general-purpose, isolated-context subagent to
 * handle one focused, self-contained task and return only its final report.
 *
 * This is sky's analogue of Claude Code's Task tool. Subagent types are
 * discovered from built-ins plus `.claude/agents` / `.sky/agents` definition
 * files (see core/subagent). Subagents never receive spawn_agent themselves,
 * so there is no recursive fan-out.
 */

import type { ToolDefinition } from '../core/tool';
import type { ToolRegistry } from '../core/tool';
import type { SkillRegistry } from '../core/skill';
import type { LLMClient } from '../core/llm';
import type { MessageBus } from '../core/bus';
import { loadSubagentDefinitions, runSubagent } from '../core/subagent';

export function createSpawnAgentTool(opts: {
  config: any;
  llm: LLMClient;
  bus: MessageBus;
  baseToolRegistry: ToolRegistry;
  baseSkillRegistry: SkillRegistry;
  cwd?: string;
}): ToolDefinition {
  const cwd = opts.cwd || process.cwd();

  const buildDescription = (): string => {
    const defs = loadSubagentDefinitions(cwd);
    const lines = [...defs.values()].map((d) => `  - ${d.name}: ${d.description}`);
    return (
      '派生一个隔离上下文的子智能体来独立完成一个聚焦、自洽的任务,只返回它的最终报告。' +
      '当任务需要大量搜索/调研、或你想把一段独立工作从主上下文里隔离出去时使用。' +
      '子智能体看不到你的对话历史,所以 task 必须自带全部所需上下文(目标、相关文件、约束)。' +
      '它无法反问你,会一次性完成并汇报。可并行派生多个互不依赖的子智能体。\n\n可用子智能体类型:\n' +
      lines.join('\n')
    );
  };

  return {
    name: 'spawn_agent',
    description: buildDescription(),
    parameters: [
      {
        name: 'agent_type',
        type: 'string',
        description: '子智能体类型(见工具描述中的可用类型,如 general-purpose / explore 或自定义)',
        required: true,
      },
      {
        name: 'task',
        type: 'string',
        description: '完整、自洽的任务描述。子智能体看不到对话历史,必须在此写清目标、相关文件路径与约束。',
        required: true,
      },
      {
        name: 'description',
        type: 'string',
        description: '可选:对该任务的简短(3-5 词)标签,用于展示。',
        required: false,
      },
    ],
    // Long-running by nature (full nested agent loop); give it generous headroom.
    timeout: 600000,
    handler: async (params) => {
      const agentType = String(params.agent_type || '').trim();
      const task = String(params.task || '').trim();
      if (!agentType) return '[spawn_agent error] agent_type is required.';
      if (!task) return '[spawn_agent error] task is required.';

      const defs = loadSubagentDefinitions(cwd);
      const def = defs.get(agentType);
      if (!def) {
        const available = [...defs.keys()].join(', ');
        return `[spawn_agent error] unknown agent_type '${agentType}'. Available: ${available}`;
      }

      const report = await runSubagent({
        def,
        task,
        config: opts.config,
        llm: opts.llm,
        bus: opts.bus,
        baseToolRegistry: opts.baseToolRegistry,
        baseSkillRegistry: opts.baseSkillRegistry,
      });

      const header = `[subagent ${def.name} 完成]`;
      return `${header}\n${report}`;
    },
  };
}
