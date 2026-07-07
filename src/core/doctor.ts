import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import * as yaml from 'yaml';
import { resolveWorkspacePath } from './workspace';

const VERSION = (() => {
  try { return String(require('../../package.json').version); }
  catch { return 'unknown'; }
})();

const AGENT_NAMES = ['fog', 'rain', 'frost', 'snow', 'dew', 'fair'] as const;
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'vllm', 'litellm']);

type ConfigRecord = Record<string, unknown>;

export type DoctorStatus = 'pass' | 'warn' | 'fail';
export type PortProbeState = 'free' | 'skyloom' | 'occupied';

export interface PortProbeResult {
  port: number;
  state: PortProbeState;
}

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  title: string;
  detail: string;
  action?: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  ok: boolean;
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  homeDir?: string;
  cwd?: string;
  nodeVersion?: string;
  env?: NodeJS.ProcessEnv;
  probePort?: (port: number) => Promise<PortProbeResult>;
  now?: () => Date;
}

function check(id: string, status: DoctorStatus, title: string, detail: string, action?: string): DoctorCheck {
  return { id, status, title, detail, ...(action ? { action } : {}) };
}

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ConfigRecord
    : {};
}

function safeParseRecord(file: string): { value: ConfigRecord | null; error?: string } {
  if (!fs.existsSync(file)) return { value: null };
  try {
    const parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    if (parsed == null) return { value: {} };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: 'configuration root must be a mapping' };
    }
    return { value: parsed as ConfigRecord };
  } catch (error) {
    const firstLine = String((error as Error).message || error).split(/\r?\n/, 1)[0];
    return { value: null, error: firstLine.slice(0, 160) };
  }
}

function findBundledConfigDir(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'config'),
    path.join(__dirname, '..', '..', '..', 'config'),
    path.join(__dirname, '..', 'config'),
    path.join(process.cwd(), 'config'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'default.yaml')))
    ?? candidates[0];
}

function mergeConfigs(defaultConfig: ConfigRecord, userConfig: ConfigRecord | null): ConfigRecord {
  if (!userConfig) return defaultConfig;
  const merged: ConfigRecord = { ...defaultConfig, ...userConfig };
  for (const key of ['agents', 'providers', 'models', 'llm']) {
    merged[key] = { ...asRecord(defaultConfig[key]), ...asRecord(userConfig[key]) };
  }
  return merged;
}

function loadModelCatalog(configDir: string): Array<{ id: string; provider: string }> {
  const parsed = safeParseRecord(path.join(configDir, 'models.yaml')).value ?? {};
  const entries: Array<{ id: string; provider: string }> = [];
  for (const [provider, models] of Object.entries(parsed)) {
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const id = String(asRecord(model).name ?? '').trim();
      if (id) entries.push({ id, provider });
    }
  }
  return entries;
}

function findModel(catalog: Array<{ id: string; provider: string }>, modelId: string): { id: string; provider: string } | null {
  const exact = catalog.find((model) => model.id === modelId);
  if (exact) return exact;
  const stripped = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  return catalog.find((model) => model.id === stripped || model.id.split('/').slice(1).join('/') === modelId) ?? null;
}

function nearestExistingParent(target: string): string | null {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function writableCheck(id: string, title: string, target: string): DoctorCheck {
  const existing = nearestExistingParent(target);
  if (!existing) {
    return check(id, 'fail', title, `No existing parent directory for ${target}`, `Create a writable parent directory for ${target}.`);
  }
  try {
    fs.accessSync(existing, fs.constants.R_OK | fs.constants.W_OK);
    return check(id, 'pass', title, `${target} is writable${existing === path.resolve(target) ? '' : ` via ${existing}`}.`);
  } catch {
    return check(id, 'fail', title, `${existing} is not readable and writable.`, `Grant the current user access to ${existing}.`);
  }
}

async function memoryIntegrityCheck(directory: string): Promise<DoctorCheck> {
  const managedFiles = [...AGENT_NAMES.map((name) => `${name}.db`), '.db']
    .filter((name) => fs.existsSync(path.join(directory, name)));
  if (managedFiles.length === 0) {
    return check('memory.integrity', 'pass', 'Memory database integrity', 'No persisted memory database exists yet.');
  }

  const invalid: string[] = [];
  try {
    const SQL = await initSqlJs();
    for (const name of managedFiles) {
      let database: InstanceType<typeof SQL.Database> | null = null;
      try {
        database = new SQL.Database(fs.readFileSync(path.join(directory, name)));
        const result = database.exec('PRAGMA integrity_check');
        const rows = result.flatMap((table) => table.values).flat();
        if (rows.length !== 1 || String(rows[0]).toLowerCase() !== 'ok') invalid.push(name);
      } catch {
        invalid.push(name);
      } finally {
        database?.close();
      }
    }
  } catch (error) {
    return check(
      'memory.integrity',
      'fail',
      'Memory database integrity',
      `Database files could not be inspected: ${String((error as Error).message || error).slice(0, 120)}`,
      `Back up ${directory} and verify the Skyloom installation before retrying.`,
    );
  }

  if (invalid.length > 0) {
    return check(
      'memory.integrity',
      'fail',
      'Memory database integrity',
      `SQLite integrity check failed: ${invalid.join(', ')}.`,
      `Back up ${directory}, then restore the affected database or remove it to start a new history.`,
    );
  }
  return check('memory.integrity', 'pass', 'Memory database integrity', `${managedFiles.length} managed database file(s) passed SQLite integrity_check.`);
}

function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function isSkyloomStatusPayload(value: unknown): boolean {
  const body = asRecord(value);
  const runtime = asRecord(body.runtime);
  const agents = asRecord(body.agents);
  const summary = asRecord(agents.summary);
  const tools = asRecord(body.tools);
  return typeof body.version === 'string'
    && typeof runtime.node === 'string'
    && typeof runtime.pid === 'number'
    && typeof summary.total === 'number'
    && typeof summary.busy === 'number'
    && typeof summary.idle === 'number'
    && typeof agents.items === 'object'
    && agents.items !== null
    && typeof tools.registered === 'number';
}

async function tcpPortState(port: number): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (state: PortProbeState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* server may not be listening */ }
      resolve({ port, state });
    };
    const timer = setTimeout(() => finish('occupied'), 1000);
    server.unref();
    server.once('error', () => finish('occupied'));
    server.listen(port, '127.0.0.1', () => {
      if (settled) {
        server.close();
        return;
      }
      finish('free');
    });
  });
}

async function defaultProbePort(port: number): Promise<PortProbeResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(600),
    });
    if (response.ok && isSkyloomStatusPayload(await response.json())) {
      return { port, state: 'skyloom' };
    }
  } catch { /* continue with a bounded TCP availability probe */ }
  return tcpPortState(port);
}

function portCheck(id: string, title: string, result: PortProbeResult): DoctorCheck {
  if (result.state === 'free') return check(id, 'pass', title, `Port ${result.port} is available.`);
  if (result.state === 'skyloom') return check(id, 'pass', title, `Skyloom is already listening on port ${result.port}.`);
  return check(
    id,
    'warn',
    title,
    `Port ${result.port} is owned by another process.`,
    `Use --port ${result.port + 1} or stop the process currently using port ${result.port}.`,
  );
}

function resolveConfiguredPath(value: string, homeDir: string, cwd: string): string {
  const expanded = value.replace(/^~(?=$|[\\/])/, homeDir);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, 'sk-[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b((?:authorization|api[_-]?key|token)\s*[:=]\s*)[^\s,;\\/]+/gi, '$1[REDACTED]');
}

function sanitizeCheck(item: DoctorCheck): DoctorCheck {
  return {
    ...item,
    title: sanitizeText(item.title),
    detail: sanitizeText(item.detail),
    ...(item.action ? { action: sanitizeText(item.action) } : {}),
  };
}

/** Build a sanitized diagnosis without mutating configuration, memory or runtime state. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const nodeVersion = options.nodeVersion ?? process.version;
  const env = options.env ?? process.env;
  const probePort = options.probePort ?? defaultProbePort;
  const checks: DoctorCheck[] = [];
  const configDir = findBundledConfigDir();

  const nodeMajor = parseNodeMajor(nodeVersion);
  checks.push(nodeMajor >= 18
    ? check('runtime.node', 'pass', 'Node.js runtime', `${nodeVersion} satisfies Node.js >= 18.`)
    : check('runtime.node', 'fail', 'Node.js runtime', `${nodeVersion} is unsupported.`, 'Install Node.js 18 or newer.'));

  const requiredAssets = ['default.yaml', 'models.yaml', 'providers.yaml'];
  const missingAssets = requiredAssets.filter((name) => !fs.existsSync(path.join(configDir, name)));
  checks.push(missingAssets.length === 0
    ? check('config.bundled', 'pass', 'Bundled configuration', `Configuration assets are available in ${configDir}.`)
    : check('config.bundled', 'fail', 'Bundled configuration', `Missing: ${missingAssets.join(', ')}.`, 'Reinstall Skyloom from a complete package.'));

  const userConfigPath = path.join(homeDir, '.skyloom', 'config.yaml');
  const parsed = safeParseRecord(userConfigPath);
  if (parsed.error) {
    checks.push(check('config.user', 'fail', 'User configuration', `Invalid YAML: ${parsed.error}`, `Fix or replace ${userConfigPath}.`));
  } else if (!parsed.value) {
    checks.push(check('config.user', 'warn', 'User configuration', `No user configuration at ${userConfigPath}.`, 'Run sky chat to start the setup wizard.'));
  } else {
    checks.push(check('config.user', 'pass', 'User configuration', `${userConfigPath} parsed successfully.`));
  }

  const defaults = safeParseRecord(path.join(configDir, 'default.yaml')).value ?? {};
  const config = mergeConfigs(defaults, parsed.value);
  const llm = asRecord(config.llm);
  const activeModel = String(config.default_model || llm.default_model || '').trim();
  const catalog = loadModelCatalog(configDir);
  const modelInfo = findModel(catalog, activeModel);
  if (modelInfo) {
    checks.push(check('model.active', 'pass', 'Active model', `${activeModel} resolves to provider ${modelInfo.provider}.`));
  } else {
    const suggestions = catalog.slice(0, 6).map((model) => model.id);
    checks.push(check(
      'model.active',
      'fail',
      'Active model',
      activeModel ? `${activeModel} is not present in the model catalog.` : 'No active model is configured.',
      `Choose a catalog model${suggestions.length ? ` such as ${suggestions.join(', ')}` : ''}.`,
    ));
  }

  const provider = String(config.default_provider || modelInfo?.provider || '').trim();
  const providerCatalog = safeParseRecord(path.join(configDir, 'providers.yaml')).value ?? {};
  const envVar = String(asRecord(providerCatalog[provider]).env_var ?? '').trim();
  const apiKeys = asRecord(config.api_keys);
  const credentialSource = envVar && env[envVar]
    ? `environment variable ${envVar}`
    : apiKeys[provider]
      ? 'local Skyloom configuration'
      : '';
  if (LOCAL_PROVIDERS.has(provider)) {
    checks.push(check('credential.active', 'pass', 'Active provider credential', `${provider} does not require an API key.`));
  } else if (provider && credentialSource) {
    checks.push(check('credential.active', 'pass', 'Active provider credential', `Credential is available from ${credentialSource}.`));
  } else {
    checks.push(check(
      'credential.active',
      'fail',
      'Active provider credential',
      provider ? `No credential is configured for ${provider}.` : 'The active provider could not be resolved.',
      provider ? `Set ${envVar || `${provider.toUpperCase()}_API_KEY`} or run sky apikey set ${provider} <key>.` : 'Select a valid provider and model.',
    ));
  }

  try {
    const workspaceConfig = asRecord(config.workspace);
    const workspaceValue = String(workspaceConfig.path || 'auto');
    const workspace = resolveWorkspacePath(workspaceValue, { homeDir, cwd });
    checks.push(writableCheck('workspace.write', 'Workspace storage', workspace));
  } catch (error) {
    checks.push(check('workspace.write', 'fail', 'Workspace storage', `Workspace path could not be resolved: ${String(error)}`, 'Set workspace.path to a writable directory.'));
  }

  const memoryConfig = asRecord(config.memory);
  const memoryValue = String(memoryConfig.db_path || memoryConfig.dbPath || path.join(homeDir, '.skyloom', 'memory.db'));
  const memoryDirectory = path.dirname(resolveConfiguredPath(memoryValue, homeDir, cwd));
  checks.push(writableCheck('memory.write', 'Memory storage', memoryDirectory));
  checks.push(await memoryIntegrityCheck(memoryDirectory));

  const projectMcpPath = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(projectMcpPath)) {
    checks.push(check('mcp.project', 'pass', 'Project MCP configuration', 'No project .mcp.json is configured.'));
  } else {
    try {
      const value = JSON.parse(fs.readFileSync(projectMcpPath, 'utf8')) as Record<string, unknown>;
      const valid = value.mcpServers == null || (typeof value.mcpServers === 'object' && !Array.isArray(value.mcpServers));
      checks.push(valid
        ? check('mcp.project', 'pass', 'Project MCP configuration', `${projectMcpPath} is valid JSON.`)
        : check('mcp.project', 'fail', 'Project MCP configuration', 'mcpServers must be an object.', `Fix ${projectMcpPath}.`));
    } catch (error) {
      checks.push(check('mcp.project', 'fail', 'Project MCP configuration', `Invalid JSON: ${String((error as Error).message).slice(0, 120)}`, `Fix ${projectMcpPath}.`));
    }
  }

  const [webPort, gatewayPort] = await Promise.all([probePort(7777), probePort(8848)]);
  checks.push(portCheck('port.web', 'Web port', webPort));
  checks.push(portCheck('port.gateway', 'Gateway port', gatewayPort));

  const sanitizedChecks = checks.map(sanitizeCheck);
  const summary: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const item of sanitizedChecks) summary[item.status]++;
  return {
    schemaVersion: 1,
    version: VERSION,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    ok: summary.fail === 0,
    summary,
    checks: sanitizedChecks,
  };
}

/** Render a concise human report while keeping JSON as the automation contract. */
export function formatDoctorReport(report: DoctorReport): string {
  const marks: Record<DoctorStatus, string> = { pass: '[ok]', warn: '[!]', fail: '[x]' };
  const lines = [`Skyloom v${report.version} - sky doctor`, ''];
  for (const item of report.checks) {
    lines.push(`${marks[item.status]} ${item.title}: ${item.detail}`);
    if (item.action) lines.push(`    Next: ${item.action}`);
  }
  lines.push('', `Result: ${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed.`);
  return lines.join('\n') + '\n';
}
