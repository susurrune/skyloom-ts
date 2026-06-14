/**
 * 沙箱隔离模块 — Shell execution sandbox with resource limits.
 *
 * All `run_bash` / `shell_exec` commands are wrapped through this module
 * to ensure: temp directory isolation, timeout enforcement, output size
 * limits, and dangerous command detection BEFORE execution.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { REDLINE_PATTERNS, REDLINE_COMMANDS } from "./security";

/* ═══════════════════════════════════════
   Configuration
   ═══════════════════════════════════════ */
const SANDBOX_DIR = path.join(os.homedir(), ".skyloom", "sandbox");
const DEFAULT_TIMEOUT_MS = 30000;  // 30s max
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB max output
const HARD_TIMEOUT_MS = 120000;      // 2min absolute max
// Whitelist of safe commands that don't need sandbox
const SAFE_COMMANDS = new Set(["echo", "pwd", "whoami", "date", "hostname", "uname", "ls", "dir", "cat", "head", "tail", "wc", "env", "printenv"]);

/* ═══════════════════════════════════════
   Sandbox lifecycle
   ═══════════════════════════════════════ */
function ensureSandbox(): string {
  if (!fs.existsSync(SANDBOX_DIR)) fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  // Create named temp dir for this execution
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(SANDBOX_DIR, `job_${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ═══════════════════════════════════════
   Pre-execution check
   ═══════════════════════════════════════ */
export function preflightCheck(command: string): string | null {
  if (!command || !command.trim()) return "Empty command";

  const lower = command.toLowerCase().trim();

  // Red-line patterns
  for (const pattern of REDLINE_PATTERNS) {
    if (pattern.test(lower)) return `REDLINE: pattern '${pattern.source.slice(0, 40)}' detected`;
  }
  for (const forbidden of REDLINE_COMMANDS) {
    if (lower.includes(forbidden)) return `REDLINE: forbidden command '${forbidden}'`;
  }

  // Network exfiltration attempts
  if (/curl.*\|.*nc\s/.test(lower) || /wget.*-O.*>/.test(lower)) return "BLOCKED: potential data exfiltration";
  if (/nc\s+\S+\s+\d+/.test(lower) && /\|/.test(lower)) return "BLOCKED: potential reverse shell";

  return null;
}

/* ═══════════════════════════════════════
   Execute in sandbox
   ═══════════════════════════════════════ */
export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
  durationMs: number;
  sandboxDir: string;
  checkFailed?: string;
}

export function runInSandbox(command: string, opts?: {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}): SandboxResult {
  // Pre-flight
  const check = preflightCheck(command);
  if (check) {
    return { success: false, stdout: "", stderr: check, exitCode: -1, killed: false, durationMs: 0, sandboxDir: "", checkFailed: check };
  }

  const dir = ensureSandbox();
  const timeout = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    // For safe commands, run in-place without sandbox overhead
    const firstWord = command.trim().split(/\s+/)[0].toLowerCase();
    if (SAFE_COMMANDS.has(firstWord)) {
      const result = execSync(command, { encoding: "utf-8", timeout, maxBuffer: MAX_OUTPUT_BYTES, cwd: opts?.cwd || dir, env: { ...process.env, ...(opts?.env || {}) } });
      cleanup(dir);
      return { success: true, stdout: result.slice(0, MAX_OUTPUT_BYTES), stderr: "", exitCode: 0, killed: false, durationMs: Date.now() - t0, sandboxDir: dir };
    }

    // Dangerous command — run in sandbox with isolation
    const result = execSync(command, {
      encoding: "utf-8",
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      cwd: dir,                    // isolate to temp dir
      env: { ...process.env, ...(opts?.env || {}), TMPDIR: dir, TEMP: dir },
      windowsHide: true,
    });

    cleanup(dir);
    return { success: true, stdout: result.slice(0, MAX_OUTPUT_BYTES), stderr: "", exitCode: 0, killed: false, durationMs: Date.now() - t0, sandboxDir: dir };

  } catch (e: any) {
    const durationMs = Date.now() - t0;
    const killed = e.killed || e.signal !== undefined || durationMs >= timeout;
    const stdout = (e.stdout || "").slice(0, MAX_OUTPUT_BYTES);
    const stderr = (e.stderr || e.message || "").slice(0, MAX_OUTPUT_BYTES);
    cleanup(dir);
    return { success: false, stdout, stderr, exitCode: e.status || -1, killed, durationMs, sandboxDir: dir };
  }
}

/* ═══════════════════════════════════════
   Format result for display
   ═══════════════════════════════════════ */
export function formatSandboxResult(r: SandboxResult): string {
  if (r.checkFailed) return `[BLOCKED] ${r.checkFailed}`;

  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  if (r.killed) parts.push(`[killed after ${r.durationMs}ms]`);
  if (r.exitCode !== 0) parts.push(`[exit code: ${r.exitCode}]`);

  parts.push(`[sandbox: ${r.sandboxDir || "n/a"} · ${r.durationMs}ms]`);
  return parts.join("\n");
}
