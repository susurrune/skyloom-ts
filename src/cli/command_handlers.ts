import {
  clearAgentModel,
  describeAgentLLM,
  setAgentApiKey,
  setAgentModel,
  setUnifiedModel,
} from '../core/model_config';
import {
  resolveVerifyConfig,
  runVerify,
  type VerifyConfig,
  type VerifyResult,
} from '../core/verify';
import { listProviders, modelsFor, providerLabel } from '../core/catalog';

export type CommandTone = 'normal' | 'dim' | 'success' | 'warning' | 'error';

export interface CommandLine {
  text: string;
  tone: CommandTone;
}

export interface CommandOutcome {
  handled: boolean;
  lines: CommandLine[];
}

export interface SessionSummary {
  id: string;
  preview?: string;
  messageCount?: number;
}

interface CommandMemory {
  shortTerm: Array<{ role?: string; content?: unknown }>;
  working: Record<string, unknown>;
  listSessions(): Promise<SessionSummary[]>;
  getActiveSession(): string | null;
  clearShortTerm(): Promise<void>;
  createSession(): Promise<string>;
  loadSession(id: string): Promise<boolean>;
}

interface CommandAgent {
  name: string;
  displayName: string;
  state: string;
  memory: CommandMemory;
}

export interface CommandRuntime {
  agent: CommandAgent;
  config: Record<string, unknown>;
  sessionCache: { items: SessionSummary[] };
  modelConfigDir?: string;
  afterNewSession?: () => void | Promise<void>;
  verifyResolver?: (config: Record<string, unknown>) => VerifyConfig;
  verifyRunner?: (config: VerifyConfig) => VerifyResult;
}

const line = (text: string, tone: CommandTone = 'normal'): CommandLine => ({ text, tone });
const handled = (...lines: CommandLine[]): CommandOutcome => ({ handled: true, lines });

function modelOutcome(input: string, runtime: CommandRuntime): CommandOutcome {
  const { agent, config, modelConfigDir } = runtime;
  const parts = input.trim().split(/\s+/).slice(1);

  if (parts.length === 0) {
    const description = describeAgentLLM(config, agent.name, modelConfigDir);
    const source = description.source === 'agent' ? '独立配置' : '统一配置';
    const defaultModel = String(config.default_model
      ?? (config.llm as Record<string, unknown> | undefined)?.default_model
      ?? 'gpt-4o');
    return handled(
      line(`${agent.name} · ${description.model} (${source} · ${description.provider ?? '?'} · key:${description.keySource})`),
      line(`统一默认: ${defaultModel}`, 'dim'),
      line('/model <id> 单独切换 · /model unified <id> 修改默认 · /model reset 回到统一 · /model key <key>', 'dim'),
    );
  }

  const action = parts[0].toLowerCase();
  if (action === 'reset') {
    clearAgentModel(config, agent.name, modelConfigDir);
    return handled(line(`✓ ${agent.name} 已回到统一配置 · ${describeAgentLLM(config, agent.name, modelConfigDir).model}`, 'success'));
  }

  if (action === 'unified' || action === 'default') {
    if (!parts[1]) return handled(line('用法: /model unified <模型id>', 'warning'));
    const result = setUnifiedModel(config, parts[1], modelConfigDir);
    if (!result.ok) return handled(line(modelNotFound(parts[1], result.suggestions), 'warning'));
    return handled(line(`✓ 统一默认 → ${parts[1]}${result.provider ? ` (${result.provider})` : ''}`, 'success'));
  }

  if (action === 'key') {
    if (!parts[1]) return handled(line('用法: /model key <api-key>', 'warning'));
    setAgentApiKey(config, agent.name, parts[1], modelConfigDir);
    return handled(line(`✓ ${agent.name} 的独立 API key 已保存`, 'success'));
  }

  const result = setAgentModel(config, agent.name, parts[0], modelConfigDir);
  if (!result.ok) return handled(line(modelNotFound(parts[0], result.suggestions), 'warning'));
  return handled(
    line(`✓ ${agent.name} → ${parts[0]}${result.provider ? ` (${result.provider})` : ''} · 下一条消息生效`, 'success'),
  );
}

function modelNotFound(model: string, suggestions: string[]): string {
  return `'${model}' 不在目录中${suggestions.length ? ` · 可选: ${suggestions.join(', ')}` : ''}`;
}

async function listSessions(runtime: CommandRuntime): Promise<CommandOutcome> {
  const sessions = await runtime.agent.memory.listSessions();
  runtime.sessionCache.items = sessions;
  const active = runtime.agent.memory.getActiveSession();
  const lines = [line(`${runtime.agent.displayName} 会话 (${sessions.length})`)];
  if (sessions.length === 0) lines.push(line('（暂无历史会话）', 'dim'));
  for (const [index, session] of sessions.slice(0, 20).entries()) {
    const mark = session.id === active ? '●' : '·';
    const preview = (session.preview || '(空)').replace(/\s+/g, ' ').slice(0, 42);
    lines.push(line(`${mark} ${String(index + 1).padStart(2)} ${preview} · ${session.messageCount ?? 0}条 · ${session.id.slice(0, 8)}`, 'dim'));
  }
  lines.push(line('/resume <序号或id> 恢复 · /new 新会话', 'dim'));
  return handled(...lines);
}

async function resumeSession(input: string, runtime: CommandRuntime): Promise<CommandOutcome> {
  const arg = input.slice('/resume'.length).trim();
  if (runtime.sessionCache.items.length === 0) {
    runtime.sessionCache.items = await runtime.agent.memory.listSessions();
  }
  const sessions = runtime.sessionCache.items;
  const target = !arg
    ? sessions[0]
    : /^\d+$/.test(arg)
      ? sessions[Number.parseInt(arg, 10) - 1]
      : sessions.find((session) => session.id.startsWith(arg));

  if (!target) return handled(line('未找到该会话。先 /sessions 查看列表。', 'warning'));
  if (!await runtime.agent.memory.loadSession(target.id)) return handled(line('恢复失败。', 'error'));
  const messageCount = runtime.agent.memory.shortTerm.filter((message) => message.role !== 'system').length;
  return handled(
    line(`↺ 已恢复会话 · ${messageCount} 条消息 · ${target.id.slice(0, 8)}`, 'success'),
    ...(target.preview ? [line(`「${target.preview.replace(/\s+/g, ' ').slice(0, 50)}」`, 'dim')] : []),
  );
}

async function newSession(runtime: CommandRuntime): Promise<CommandOutcome> {
  await runtime.agent.memory.clearShortTerm();
  await runtime.afterNewSession?.();
  const id = await runtime.agent.memory.createSession();
  runtime.sessionCache.items = [];
  return handled(line(`✦ 新会话已开始 · ${String(id).slice(0, 8)}`, 'success'));
}

function verify(runtime: CommandRuntime): CommandOutcome {
  const config = (runtime.verifyResolver ?? resolveVerifyConfig)(runtime.config);
  if (config.commands.length === 0) {
    return handled(line('未配置验证命令 — config.yaml verify.commands 或 SKY.md ## Verify', 'warning'));
  }
  const result = (runtime.verifyRunner ?? runVerify)(config);
  const lines = [line(`验证 · ${config.commands.length} 条命令`, 'dim')];
  for (const reportLine of result.report.split('\n').slice(0, 30)) {
    const tone: CommandTone = reportLine.startsWith('✓') ? 'success' : reportLine.startsWith('✗') ? 'error' : 'dim';
    lines.push(line(reportLine, tone));
  }
  return handled(...lines);
}

function modelsOutcome(input: string): CommandOutcome {
  const filter = input.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
  const providers = listProviders();
  const lines: CommandLine[] = [line('✦ 模型目录 · Model Catalog')];
  let visibleProviders = 0;
  let totalModels = 0;

  for (const provider of providers) {
    const label = providerLabel(provider);
    if (filter && !provider.toLowerCase().includes(filter) && !label.toLowerCase().includes(filter)) continue;
    const models = modelsFor(provider);
    if (models.length === 0) continue;
    visibleProviders++;
    lines.push(line(label));
    for (const model of models) {
      totalModels++;
      const context = model.context >= 1_000_000
        ? `${Math.round(model.context / 1_000_000)}M`
        : model.context >= 1_000
          ? `${Math.round(model.context / 1_000)}K`
          : String(model.context);
      const cost = model.costIn === 0 && model.costOut === 0
        ? '免费'
        : `$${model.costIn.toFixed(2)}/$${model.costOut.toFixed(2)}`;
      lines.push(line(`· ${model.id} · ${context} · ${cost} · ${model.desc}`, 'dim'));
    }
  }

  if (totalModels === 0) lines.push(line(`没有匹配 “${filter}” 的模型`, 'warning'));
  lines.push(line(`共 ${visibleProviders} 个 Provider · ${totalModels} 个模型`, 'dim'));
  lines.push(line('用法: /models [provider] 筛选 · /model <id> 切换', 'dim'));
  return handled(...lines);
}

export async function executeSlashCommand(input: string, runtime: CommandRuntime): Promise<CommandOutcome> {
  const command = input.trim().split(/\s+/, 1)[0].toLowerCase();
  if (command === '/status') {
    const { agent } = runtime;
    return handled(line(`${agent.displayName} (${agent.name}) · ${agent.state} · 记忆 ${agent.memory.shortTerm.length} 条`));
  }
  if (command === '/sessions') return listSessions(runtime);
  if (command === '/resume') return resumeSession(input, runtime);
  if (command === '/new') return newSession(runtime);
  if (command === '/model') return modelOutcome(input, runtime);
  if (command === '/models') return modelsOutcome(input);
  if (command === '/verify') return verify(runtime);
  return { handled: false, lines: [] };
}
