/**
 * Delegate tool — allows agents to delegate tasks to other agents.
 */

import type { ToolDefinition } from '../core/tool';
import type { BaseAgent } from '../core/agent';

/**
 * Create a delegate_to tool for an agent to delegate tasks to other agents.
 */
export function createDelegateTool(
  agentMap: Map<string, BaseAgent>,
  callingAgent: BaseAgent
): ToolDefinition {
  return {
    name: 'delegate_to',
    description: 'Delegate a task to another agent. Use this when the task requires a different specialty or when context is overflowing.',
    parameters: [
      {
        name: 'agent',
        type: 'string',
        description: 'Target agent name: fog (research), rain (code/writing), frost (review), dew (ops/deploy), snow (planning)',
        required: true,
      },
      {
        name: 'task',
        type: 'string',
        description: 'Clear, self-contained task description for the target agent',
        required: true,
      },
    ],
    handler: async (params) => {
      const targetName = params.agent as string;
      const taskDesc = params.task as string;

      const targetAgent = agentMap.get(targetName);
      if (!targetAgent) {
        return `Error: Agent '${targetName}' not found. Available agents: ${[...agentMap.keys()].join(', ')}`;
      }

      try {
        const result = await callingAgent.requestHelp(targetName, taskDesc, 120);
        return result;
      } catch (e) {
        return `Error delegating to ${targetName}: ${e}`;
      }
    },
  };
}
