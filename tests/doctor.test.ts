import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDoctorReport,
  isSkyloomStatusPayload,
  runDoctor,
  type PortProbeResult,
} from '../src/core/doctor';
import { runDoctorCommand } from '../src/cli/doctor';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skyloom-doctor-'));
  roots.push(root);
  return root;
}

function writeConfig(root: string, body: string): void {
  const dir = path.join(root, '.skyloom');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), body, 'utf8');
}

const freePorts = async (port: number): Promise<PortProbeResult> => ({ port, state: 'free' });

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('enterprise doctor', () => {
  it('does not migrate legacy user data when the doctor command starts', () => {
    const root = tempRoot();
    const legacy = path.join(root, '.weather-agents');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'legacy: true\n', 'utf8');

    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      'src/cli/main.ts', 'doctor', '--json',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    });

    expect([0, 1], result.stderr).toContain(result.status);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1 });
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(root, '.skyloom'))).toBe(false);
  });

  it('preserves legacy migration when configuration is explicitly loaded', () => {
    const root = tempRoot();
    const legacy = path.join(root, '.weather-agents');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.yaml'), 'default_model: gpt-4o\n', 'utf8');

    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      'src/cli/main.ts', 'config',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, HOME: root, USERPROFILE: root },
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(path.join(root, '.skyloom', 'config.yaml'))).toBe(true);
  });

  it('returns a sanitized machine-readable report for a healthy environment', async () => {
    const root = tempRoot();
    const workspace = path.join(root, 'workspace');
    const memory = path.join(root, '.skyloom', 'memory.db');
    writeConfig(root, [
      'default_model: gpt-4o',
      'default_provider: openai',
      'api_keys:',
      '  openai: sk-super-secret',
      'workspace:',
      `  path: ${JSON.stringify(workspace)}`,
      'memory:',
      `  db_path: ${JSON.stringify(memory)}`,
      '',
    ].join('\n'));

    const report = await runDoctor({
      homeDir: root,
      cwd: root,
      nodeVersion: 'v22.14.0',
      env: {},
      probePort: freePorts,
      now: () => new Date('2026-07-07T00:00:00.000Z'),
    });

    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'runtime.node', 'config.user', 'model.active', 'credential.active',
      'workspace.write', 'memory.write', 'port.web', 'port.gateway',
    ]));
    expect(JSON.stringify(report)).not.toContain('sk-super-secret');
    expect(report.generatedAt).toBe('2026-07-07T00:00:00.000Z');
  });

  it('fails with actionable checks for invalid YAML and an unsupported Node runtime', async () => {
    const root = tempRoot();
    writeConfig(root, 'default_model: [broken');

    const report = await runDoctor({
      homeDir: root,
      cwd: root,
      nodeVersion: 'v16.20.0',
      env: {},
      probePort: freePorts,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'runtime.node')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((check) => check.id === 'config.user')).toMatchObject({
      status: 'fail',
      action: expect.stringMatching(/config\.yaml/),
    });
  });

  it('reports unknown models, missing credentials and occupied ports without exposing secrets', async () => {
    const root = tempRoot();
    writeConfig(root, [
      'default_model: imaginary-enterprise-model',
      'default_provider: openai',
      'api_keys:',
      '  unrelated: hidden-value',
      'workspace:',
      `  path: ${JSON.stringify(path.join(root, 'workspace'))}`,
      '',
    ].join('\n'));
    const probePort = async (port: number): Promise<PortProbeResult> => ({
      port,
      state: port === 7777 ? 'occupied' : 'free',
    });

    const report = await runDoctor({ homeDir: root, cwd: root, env: {}, probePort });

    expect(report.checks.find((check) => check.id === 'model.active')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((check) => check.id === 'credential.active')).toMatchObject({ status: 'fail' });
    expect(report.checks.find((check) => check.id === 'port.web')).toMatchObject({
      status: 'warn',
      action: expect.stringContaining('--port'),
    });
    expect(formatDoctorReport(report)).toContain('sky doctor');
    expect(JSON.stringify(report)).not.toContain('hidden-value');
  });

  it('redacts credential-shaped values from every report field', async () => {
    const root = tempRoot();
    writeConfig(root, [
      'default_model: sk-accidentally-pasted-secret',
      'default_provider: "Bearer bearer-secret-value"',
      'workspace:',
      `  path: ${JSON.stringify(path.join(root, 'token=workspace-secret'))}`,
      '',
    ].join('\n'));

    const serialized = JSON.stringify(await runDoctor({
      homeDir: root,
      cwd: root,
      env: {},
      probePort: freePorts,
    }));

    expect(serialized).not.toContain('accidentally-pasted-secret');
    expect(serialized).not.toContain('bearer-secret-value');
    expect(serialized).not.toContain('workspace-secret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('prints stable JSON and returns a failing exit code for automation', async () => {
    const root = tempRoot();
    writeConfig(root, 'default_model: unknown-model\ndefault_provider: openai\n');
    const output: string[] = [];

    const exitCode = await runDoctorCommand({
      json: true,
      write: (text) => output.push(text),
      doctorOptions: { homeDir: root, cwd: root, env: {}, probePort: freePorts },
    });

    const payload = JSON.parse(output.join(''));
    expect(exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model.active', status: 'fail' }),
    ]));
  });

  it('detects a corrupt persisted memory database without modifying it', async () => {
    const root = tempRoot();
    const skyloomDir = path.join(root, '.skyloom');
    writeConfig(root, [
      'default_model: gpt-4o',
      'default_provider: openai',
      'api_keys:',
      '  openai: test-only-key',
      'memory:',
      `  db_path: ${JSON.stringify(path.join(skyloomDir, 'memory.db'))}`,
      '',
    ].join('\n'));
    const corrupt = path.join(skyloomDir, 'fog.db');
    fs.writeFileSync(corrupt, 'not-a-sqlite-database', 'utf8');

    const report = await runDoctor({ homeDir: root, cwd: root, env: {}, probePort: freePorts });

    expect(report.checks.find((check) => check.id === 'memory.integrity')).toMatchObject({
      status: 'fail',
      action: expect.stringMatching(/backup|restore/i),
    });
    expect(fs.readFileSync(corrupt, 'utf8')).toBe('not-a-sqlite-database');
  });

  it('checks only managed agent databases and detects internal SQLite corruption', async () => {
    const root = tempRoot();
    const skyloomDir = path.join(root, '.skyloom');
    writeConfig(root, [
      'default_model: gpt-4o',
      'default_provider: openai',
      'api_keys:',
      '  openai: test-only-key',
      'memory:',
      `  db_path: ${JSON.stringify(path.join(skyloomDir, 'memory.db'))}`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(skyloomDir, 'unrelated.db'), 'not sqlite', 'utf8');

    const SQL = await initSqlJs();
    const database = new SQL.Database();
    database.run('CREATE TABLE messages (id INTEGER PRIMARY KEY, value TEXT)');
    database.run("INSERT INTO messages (value) VALUES ('healthy')");
    const bytes = Buffer.from(database.export());
    database.close();
    fs.writeFileSync(path.join(skyloomDir, 'rain.db'), bytes.subarray(0, 200));

    const report = await runDoctor({ homeDir: root, cwd: root, env: {}, probePort: freePorts });
    const integrity = report.checks.find((item) => item.id === 'memory.integrity');

    expect(integrity).toMatchObject({ status: 'fail' });
    expect(integrity?.detail).toContain('rain.db');
    expect(integrity?.detail).not.toContain('unrelated.db');
  });

  it('recognizes only a complete Skyloom runtime status payload', () => {
    expect(isSkyloomStatusPayload({ version: '1.26.0' })).toBe(false);
    expect(isSkyloomStatusPayload({
      version: '1.26.0',
      runtime: { node: 'v22', pid: 42 },
      agents: { summary: { total: 6, busy: 0, idle: 6 }, items: {} },
      tools: { registered: 1 },
    })).toBe(true);
  });
});
