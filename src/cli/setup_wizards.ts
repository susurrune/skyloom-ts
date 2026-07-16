import chalk from 'chalk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import * as yaml from 'yaml';
import { listProviders, modelsFor, providerLabel } from '../core/catalog';

const configPath = () => path.join(os.homedir(), '.skyloom', 'config.yaml');

function readUserConfig(): Record<string, any> {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try { return yaml.parse(fs.readFileSync(file, 'utf-8')) || {}; }
  catch { return {}; }
}

function writeUserConfig(config: Record<string, any>): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, yaml.stringify(config), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on Windows */ }
}

export function checkApiKeys(): string | null {
  const envKeys = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
  for (const key of envKeys) if (process.env[key]) return `env:${key}`;
  const keys = readUserConfig().api_keys || {};
  for (const [provider, key] of Object.entries(keys)) if (key) return `cfg:${provider}`;
  return null;
}

export function saveApiKey(provider: string, key: string): void {
  const config = readUserConfig();
  if (!config.api_keys) config.api_keys = {};
  config.api_keys[provider] = key;
  writeUserConfig(config);
}

export async function setupWizard(): Promise<{ provider: string; key: string; model: string } | null> {
  const providers = listProviders().map((id) => ({
    id,
    name: providerLabel(id),
    models: modelsFor(id).map((model) => model.id),
  }));
  process.stdout.write('\n' + chalk.cyan('  ✦ API Key 设置向导 ✦\n\n'));
  process.stdout.write(chalk.dim('  选择 Provider（Key 保存在 ~/.skyloom/config.yaml）:\n\n'));
  providers.forEach((provider, index) => {
    process.stdout.write(chalk.dim(`  ${String(index + 1).padStart(2)}. ${provider.name.padEnd(22)} ${provider.models.slice(0, 3).join(', ')}\n`));
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise((resolve) => rl.question(question, resolve));
  try {
    const choice = await ask(chalk.cyan(`\n  编号 (1-${providers.length}, q退出): `));
    if (choice === 'q') return null;
    const index = Number.parseInt(choice, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= providers.length) {
      process.stdout.write(chalk.dim('  已取消\n'));
      return null;
    }

    const provider = providers[index];
    const key = (await ask(chalk.cyan(`  ${provider.name} API Key: `))).trim();
    if (!key) return null;
    saveApiKey(provider.id, key);

    process.stdout.write(chalk.dim('\n  可用模型:\n'));
    provider.models.forEach((model, modelIndex) => process.stdout.write(chalk.dim(`  ${modelIndex + 1}. ${model}\n`)));
    const modelChoice = await ask(chalk.cyan(`\n  选择模型 (1-${provider.models.length}, 默认1): `)) || '1';
    const modelIndex = (Number.parseInt(modelChoice, 10) || 1) - 1;
    const model = provider.models[Math.max(0, Math.min(modelIndex, provider.models.length - 1))];
    const config = readUserConfig();
    config.default_model = model;
    config.default_provider = provider.id;
    writeUserConfig(config);
    process.stdout.write(chalk.green(`\n  ✓ ${provider.name} · ${model} · 就绪!\n\n`));
    return { provider: provider.id, key, model };
  } finally {
    rl.close();
  }
}

export async function channelsWizard(): Promise<void> {
  const { CHANNEL_SETUP, SETUP_CHANNEL_IDS, callbackUrl, saveChannelConfig, missingRequired } = require('../gateway/setup');
  const { renderQR } = require('../gateway/qr');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise((resolve) => rl.question(question, resolve));
  try {
    process.stdout.write('\n' + chalk.cyan('  ✦ 渠道接入向导 · sky channels ✦\n\n'));
    process.stdout.write(chalk.dim('  选择要配置的聊天软件:\n\n'));
    SETUP_CHANNEL_IDS.forEach((id: string, index: number) => process.stdout.write(chalk.dim(`  ${index + 1}. ${CHANNEL_SETUP[id].name}\n`)));
    const choice = await ask(chalk.cyan(`\n  编号 (1-${SETUP_CHANNEL_IDS.length}, q 退出): `));
    if (choice.trim().toLowerCase() === 'q') return;
    const index = Number.parseInt(choice, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= SETUP_CHANNEL_IDS.length) {
      process.stdout.write(chalk.dim('  已取消\n'));
      return;
    }
    const spec = CHANNEL_SETUP[SETUP_CHANNEL_IDS[index]];
    process.stdout.write('\n' + chalk.bold(`  配置 ${spec.name}\n\n`));
    spec.steps.forEach((step: string, stepIndex: number) => process.stdout.write(chalk.dim(`  ${stepIndex + 1}. ${step}\n`)));
    process.stdout.write(chalk.dim('\n  📱 扫码打开管理后台:  ') + chalk.cyan(spec.consoleUrl) + '\n');
    const consoleQR = renderQR(spec.consoleUrl);
    if (consoleQR) process.stdout.write('\n' + consoleQR.split('\n').map((row: string) => `    ${row}`).join('\n') + '\n');
    if (spec.docsUrl) process.stdout.write(chalk.dim(`  📖 文档: ${spec.docsUrl}\n`));

    process.stdout.write('\n' + chalk.dim('  逐项填入凭据(回车跳过可选项):\n\n'));
    const values: Record<string, string> = {};
    for (const field of spec.fields) {
      const required = field.required ? chalk.red('*') : chalk.dim('(可选)');
      if (field.hint) process.stdout.write(chalk.dim(`    ↳ ${field.hint}\n`));
      const value = await ask(chalk.cyan(`  ${field.label} ${required}: `));
      if (value.trim()) values[field.key] = value.trim();
    }
    const missing = missingRequired(spec.id, values);
    if (missing.length) process.stdout.write(chalk.yellow(`\n  ⚠ 缺少必填项: ${missing.join(', ')} — 已保存现有项,可再次运行补全。\n`));
    const savedPath = saveChannelConfig(spec.id, values);
    process.stdout.write(chalk.green(`\n  ✓ 已保存到 ${savedPath} 的 channels.${spec.id}\n`));
    const base = (await ask(chalk.cyan('\n  你的网关公网地址(如 https://bot.example.com,回车用 http://localhost:8848): '))).trim() || 'http://localhost:8848';
    const callback = callbackUrl(base, spec.id);
    process.stdout.write(chalk.dim('\n  把下面的回调 URL 填入平台后台的事件/接收配置:\n  ') + chalk.cyan(callback) + '\n');
    const callbackQR = renderQR(callback);
    if (callbackQR) process.stdout.write('\n' + callbackQR.split('\n').map((row: string) => `    ${row}`).join('\n') + '\n');
    process.stdout.write(chalk.dim('\n  完成后运行  sky gateway  启动网关。\n\n'));
  } finally {
    rl.close();
  }
}
