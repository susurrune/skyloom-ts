/**
 * 安全与对齐模块 — Security & Alignment
 *
 * Danger level grading, red-line enforcement, audit trail, human-in-the-loop.
 * All security decisions flow through this module before tool execution.
 */

import { getLogger } from "./logger";

const log = getLogger("security");

/* ── Danger levels ── */
export enum DangerLevel {
  /** Read-only, no side effects — auto-approved */
  SAFE = 0,
  /** Minor side effects (write single file, git status) — logged */
  LOW = 1,
  /** Significant side effects (overwrite, delete, git push) — notify */
  MEDIUM = 2,
  /** Dangerous (sudo, remote deploy, mass delete) — confirm */
  HIGH = 3,
  /** Red-line — NEVER execute without human-in-the-loop */
  CRITICAL = 4,
}

/* ═══════════════════════════════════════
   Red-line list: operations that are NEVER auto-approved
   ═══════════════════════════════════════ */
const REDLINE_PATTERNS = [
  /rm\s+-rf/,           /format\s+\w:/,         /dd\s+if=/,
  />\s*\/dev\/sd/,      /mkfs\./,               /:(){ :\|:& };:/,
  /sudo\s+rm/,          /chmod\s+777\s+\//,     /wget.*\|.*sh/,
  /curl.*\|.*bash/,     /eval\s+\$/,            /exec\s+\$/,
  /subprocess\.call.*rm/, /os\.system.*rm/,
];

const REDLINE_COMMANDS = [
  "shutdown", "reboot", "init 0", "init 6",
  "del /f /s /q C:\\*", "rd /s /q C:\\",
];

/* ═══════════════════════════════════════
   Per-tool danger level mapping
   ═══════════════════════════════════════ */
const TOOL_DANGER_MAP: Record<string, DangerLevel> = {
  read_file: DangerLevel.SAFE,
  list_directory: DangerLevel.SAFE,
  tree: DangerLevel.SAFE,
  file_search: DangerLevel.SAFE,
  code_search: DangerLevel.SAFE,
  grep: DangerLevel.SAFE,
  git_status: DangerLevel.SAFE,
  git_diff: DangerLevel.SAFE,
  git_log: DangerLevel.SAFE,
  system_info: DangerLevel.SAFE,
  system_diagnose: DangerLevel.SAFE,
  list_processes: DangerLevel.SAFE,
  list_installed_apps: DangerLevel.SAFE,
  list_skills: DangerLevel.SAFE,
  recall_facts: DangerLevel.SAFE,
  mcp_list_servers: DangerLevel.SAFE,
  // read-only introspection (extra.ts)
  file_info: DangerLevel.SAFE,
  hash: DangerLevel.SAFE,
  base64: DangerLevel.SAFE,
  json_query: DangerLevel.SAFE,
  dns_lookup: DangerLevel.SAFE,
  port_check: DangerLevel.SAFE,
  env_get: DangerLevel.SAFE,
  disk_usage: DangerLevel.SAFE,
  clipboard_read: DangerLevel.SAFE,
  which: DangerLevel.SAFE,
  diff_files: DangerLevel.SAFE,
  uuid: DangerLevel.SAFE,
  random_string: DangerLevel.SAFE,
  current_time: DangerLevel.SAFE,

  write_file: DangerLevel.LOW,
  edit_file: DangerLevel.LOW,
  copy_file: DangerLevel.LOW,
  move_file: DangerLevel.LOW,
  make_directory: DangerLevel.LOW,
  append_file: DangerLevel.LOW,
  replace_in_file: DangerLevel.LOW,
  gzip_file: DangerLevel.LOW,
  gunzip_file: DangerLevel.LOW,
  clipboard_write: DangerLevel.LOW,
  git_branch: DangerLevel.LOW,
  http_get: DangerLevel.LOW,
  fetch_page: DangerLevel.LOW,
  web_search: DangerLevel.LOW,
  remember_fact: DangerLevel.LOW,
  use_skill: DangerLevel.LOW,
  task_done: DangerLevel.LOW,

  delete_file: DangerLevel.MEDIUM,
  git_add: DangerLevel.MEDIUM,
  git_commit: DangerLevel.MEDIUM,
  git_checkout: DangerLevel.MEDIUM,
  http_post: DangerLevel.MEDIUM,
  http_request: DangerLevel.MEDIUM,
  download_file: DangerLevel.MEDIUM,
  mcp_add_server: DangerLevel.MEDIUM,
  mcp_remove_server: DangerLevel.MEDIUM,
  launch_app: DangerLevel.MEDIUM,
  open_path: DangerLevel.MEDIUM,
  browser_open: DangerLevel.MEDIUM,

  run_bash: DangerLevel.HIGH,
  shell_exec: DangerLevel.HIGH,
  kill_process: DangerLevel.HIGH,
  package_manager: DangerLevel.HIGH,
  service_control: DangerLevel.HIGH,
  delegate_to: DangerLevel.HIGH,
  git_push: DangerLevel.HIGH,
  git_pull: DangerLevel.HIGH,
  mcp_scaffold_server: DangerLevel.HIGH,
};

/* ═══════════════════════════════════════
   Audit trail entry
   ═══════════════════════════════════════ */
export interface AuditEntry {
  ts: string;
  agent: string;
  tool: string;
  args: Record<string, any>;
  dangerLevel: DangerLevel;
  approved: boolean;
  result: string;
  durationMs: number;
  traceId: string;
}

/* ═══════════════════════════════════════
   Security context — per-session security state
   ═══════════════════════════════════════ */
export class SecurityContext {
  public auditLog: AuditEntry[] = [];
  public deniedCount = 0;
  public autoApprovedCount = 0;
  public manualApprovedCount = 0;
  public approvalMode: "auto" | "interactive" | "strict" = "auto";

  private approvalCallback: ((tool: string, args: Record<string, any>, level: DangerLevel) => Promise<boolean>) | null = null;

  constructor(opts?: { mode?: "auto" | "interactive" | "strict"; onApprove?: (tool: string, args: Record<string, any>, level: DangerLevel) => Promise<boolean> }) {
    if (opts?.mode) this.approvalMode = opts.mode;
    if (opts?.onApprove) this.approvalCallback = opts.onApprove;
  }

  /** Get the danger level for a tool. Defaults to SAFE for unknown tools. */
  getDangerLevel(toolName: string): DangerLevel {
    return TOOL_DANGER_MAP[toolName] ?? DangerLevel.SAFE;
  }

  /** Check if arguments contain red-line patterns (critical danger). */
  checkRedline(toolName: string, args: Record<string, any>): string | null {
    if (toolName !== "run_bash" && toolName !== "shell_exec") return null;
    const cmd = String(args.command || args.cmd || "").toLowerCase();
    for (const pattern of REDLINE_PATTERNS) {
      if (pattern.test(cmd)) return `Red-line pattern detected: ${pattern.source.slice(0, 40)}`;
    }
    for (const forbidden of REDLINE_COMMANDS) {
      if (cmd.includes(forbidden)) return `Red-line command: ${forbidden}`;
    }
    return null;
  }

  /** Determine whether a tool call is permitted. Returns [approved, reason]. */
  async checkApproval(toolName: string, args: Record<string, any>, agentName: string): Promise<[boolean, string]> {
    const level = this.getDangerLevel(toolName);

    // Red-line check
    const redline = this.checkRedline(toolName, args);
    if (redline) {
      log.warn("redline_blocked", { agent: agentName, tool: toolName, reason: redline });
      return [false, redline];
    }

    // Safe — always allow
    if (level === DangerLevel.SAFE) return [true, "safe"];

    // Strict mode — deny all non-safe
    if (this.approvalMode === "strict") {
      return [false, `Strict mode: tool '${toolName}' (level ${level}) requires manual approval`];
    }

    // Auto mode — allow LOW, prompt for MEDIUM+, deny CRITICAL
    if (this.approvalMode === "auto") {
      if (level <= DangerLevel.LOW) return [true, "auto-low"];
      if (level === DangerLevel.CRITICAL) return [false, `CRITICAL tool '${toolName}' requires explicit human approval`];
      // MEDIUM/HIGH with auto mode => need callback
      if (this.approvalCallback) {
        const approved = await this.approvalCallback(toolName, args, level);
        return [approved, approved ? "user-approved" : "user-denied"];
      }
      return [true, "auto-med"]; // no callback → auto-allow but log
    }

    // Interactive mode — prompt for LOW+
    if (this.approvalCallback) {
      const approved = await this.approvalCallback(toolName, args, level);
      return [approved, approved ? "user-approved" : "user-denied"];
    }
    return [true, "no-callback"];
  }

  /** Record an audit entry. */
  recordAudit(tool: string, agent: string, args: Record<string, any>, dangerLevel: DangerLevel, approved: boolean, resultPreview: string, durationMs: number, traceId: string): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      agent, tool, args, dangerLevel, approved,
      result: resultPreview.slice(0, 500),
      durationMs, traceId,
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 5000) this.auditLog.shift();

    if (approved) {
      if (dangerLevel >= DangerLevel.HIGH) this.manualApprovedCount++;
      else this.autoApprovedCount++;
    } else {
      this.deniedCount++;
    }

    log.info(dangerLevel >= DangerLevel.HIGH ? "dangerous_tool_executed" : "tool_executed", {
      tool, agent, level: dangerLevel, approved,
    });
  }

  /** Get summary statistics. */
  getStats() {
    return {
      total: this.auditLog.length,
      denied: this.deniedCount,
      autoApproved: this.autoApprovedCount,
      manualApproved: this.manualApprovedCount,
      byLevel: {
        safe: this.auditLog.filter(e => e.dangerLevel === DangerLevel.SAFE).length,
        low: this.auditLog.filter(e => e.dangerLevel === DangerLevel.LOW).length,
        medium: this.auditLog.filter(e => e.dangerLevel === DangerLevel.MEDIUM).length,
        high: this.auditLog.filter(e => e.dangerLevel === DangerLevel.HIGH).length,
        critical: this.auditLog.filter(e => e.dangerLevel === DangerLevel.CRITICAL).length,
      },
      lastDenied: this.auditLog.filter(e => !e.approved).slice(-5).map(e => `${e.tool}: ${e.result}`),
    };
  }

  /** Install approval callback for interactive mode. */
  setApprovalCallback(fn: (tool: string, args: Record<string, any>, level: DangerLevel) => Promise<boolean>) {
    this.approvalCallback = fn;
  }
}

/* ── Global security context ── */
let globalSecurity: SecurityContext | null = null;

export function getSecurity(): SecurityContext {
  if (!globalSecurity) globalSecurity = new SecurityContext();
  return globalSecurity;
}

export function resetSecurity(): void {
  globalSecurity = null;
}

/** Red-line patterns for reference (used by tools to self-check). */
export { REDLINE_PATTERNS, REDLINE_COMMANDS };
