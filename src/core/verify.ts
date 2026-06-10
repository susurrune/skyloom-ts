/**
 * 验证闭环 — give agents a way to check their own work.
 *
 * After a task that wrote files, the configured verify commands (tests,
 * type-check, lint) run automatically; failures are fed back to the agent
 * for a bounded number of fix rounds. Mirrors Claude Code's first best
 * practice: output quality is transformed when the model can self-verify.
 *
 * Command sources (first non-empty wins):
 *   1. config.yaml:  verify: { commands: [...], max_fix_rounds, timeout_s }
 *   2. SKY.md "## Verify" section's fenced code block (see skymd.ts)
 */

import { spawnSync } from 'child_process';
import { loadProjectMemory, parseVerifyCommands } from './skymd';

export interface VerifyConfig {
  commands: string[];
  maxFixRounds: number;
  timeoutS: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Human/agent readable report (per-command status + failure tails). */
  report: string;
}

const OUTPUT_TAIL = 4000;

/** Resolve verify settings from config, falling back to SKY.md. */
export function resolveVerifyConfig(config: any, cwd: string = process.cwd()): VerifyConfig {
  const v: any = config?.verify || {};
  let commands: string[] = Array.isArray(v.commands) ? v.commands.filter((c: any) => typeof c === 'string' && c.trim()) : [];
  if (commands.length === 0) {
    try {
      commands = parseVerifyCommands(loadProjectMemory(cwd).text);
    } catch {
      commands = [];
    }
  }
  return {
    commands,
    maxFixRounds: typeof v.max_fix_rounds === 'number' ? v.max_fix_rounds : 2,
    timeoutS: typeof v.timeout_s === 'number' ? v.timeout_s : 300,
  };
}

/** Run all verify commands sequentially; stop at the first failure. */
export function runVerify(cfg: VerifyConfig, cwd: string = process.cwd()): VerifyResult {
  const lines: string[] = [];
  for (const cmd of cfg.commands) {
    const r = spawnSync(cmd, {
      shell: true,
      cwd,
      encoding: 'utf-8',
      timeout: cfg.timeoutS * 1000,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (r.status === 0) {
      lines.push(`✓ ${cmd}`);
    } else {
      const tail = out.length > OUTPUT_TAIL ? '…' + out.slice(-OUTPUT_TAIL) : out;
      const why = r.error ? String(r.error) : `exit ${r.status}`;
      lines.push(`✗ ${cmd} (${why})\n${tail}`);
      return { ok: false, report: lines.join('\n') };
    }
  }
  return { ok: true, report: lines.join('\n') };
}
