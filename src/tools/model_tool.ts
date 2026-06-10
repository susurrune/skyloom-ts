/**
 * Model self-service tools — let an agent inspect and switch its own LLM.
 *
 * Registered per-agent (same pattern as delegate_to), so the closure knows
 * which agent is asking. The runtime config object is shared by reference
 * with LLMClient, so a switch takes effect on the very next LLM call and is
 * persisted to ~/.skyloom/config.yaml.
 */

import type { ToolDefinition } from '../core/tool';
import { listProviders, modelsFor, providerLabel } from '../core/catalog';
import { setAgentModel, clearAgentModel, describeAgentLLM } from '../core/model_config';

export function createModelTools(agentName: string, runtimeConfig: any): ToolDefinition[] {
  const listModels: ToolDefinition = {
    name: 'list_models',
    description:
      'List every model available in the catalog (grouped by provider) plus your current model. ' +
      'Call this before set_my_model to pick a valid id.',
    parameters: [],
    handler: async () => {
      const me = describeAgentLLM(runtimeConfig, agentName);
      const lines: string[] = [
        `Current: ${me.model} (${me.source === 'agent' ? 'per-agent override' : 'unified default'})`,
        '',
      ];
      for (const p of listProviders()) {
        const models = modelsFor(p);
        if (!models.length) continue;
        lines.push(`${providerLabel(p)}: ${models.map(m => m.id).join(', ')}`);
      }
      return lines.join('\n');
    },
  };

  const setMyModel: ToolDefinition = {
    name: 'set_my_model',
    description:
      'Switch the LLM model YOU run on, effective from your next reply and persisted to config. ' +
      'Use when the user asks you to change/upgrade/downgrade your model. ' +
      "Pass model='default' to drop your override and follow the unified default again. " +
      'Call list_models first if unsure of valid ids.',
    parameters: [
      {
        name: 'model',
        type: 'string',
        description: "Catalog model id (e.g. 'deepseek-chat'), or 'default' to clear the override",
        required: true,
      },
    ],
    handler: async (kwargs: Record<string, any>) => {
      const modelId = String(kwargs.model || '').trim();
      if (!modelId) return '✗ model is required';

      const before = describeAgentLLM(runtimeConfig, agentName);
      if (modelId === 'default' || modelId === 'unified') {
        clearAgentModel(runtimeConfig, agentName);
        const after = describeAgentLLM(runtimeConfig, agentName);
        return `✓ ${agentName} 已回到统一配置: ${before.model} → ${after.model} (default)`;
      }

      const r = setAgentModel(runtimeConfig, agentName, modelId);
      if (!r.ok) {
        return `✗ '${modelId}' 不在模型目录中。${r.suggestions.length ? '可选: ' + r.suggestions.join(', ') : '先调 list_models 查看可用模型。'}`;
      }
      const keyNote = describeAgentLLM(runtimeConfig, agentName).keySource === 'missing'
        ? `\n⚠ 该 provider (${r.provider}) 尚无可用 API key — 提醒用户运行 /apikey set ${r.provider} <key>`
        : '';
      return `✓ ${agentName} 的模型已切换: ${before.model} → ${modelId}${r.provider ? ` (${r.provider})` : ''}，下一次回复即生效${keyNote}`;
    },
  };

  return [listModels, setMyModel];
}
