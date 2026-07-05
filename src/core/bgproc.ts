/**
 * Background process manager — long-running shells that don't block the agent.
 *
 * `run_bash` with background=true spawns a child here and returns immediately
 * with a job id. The agent later pulls incremental output (bash_output), lists
 * jobs (list_bash), or terminates one (kill_bash). Children are NOT detached,
 * so they die with the sky process — no orphan management needed across runs.
 */

import { spawn, type ChildProcess, execSync } from 'child_process';
import { getLogger } from './logger';
import { preflightCheck } from './sandbox';

const log = getLogger('bgproc');

/** Per-job rolling output cap — keep the tail, drop the oldest. */
const MAX_LOG_BYTES = 512 * 1024;

export type BgStatus = 'running' | 'exited' | 'killed' | 'error';

export interface BgJobView {
  id: string;
  command: string;
  pid: number | null;
  status: BgStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Total bytes ever produced (before any rolling trim). */
  totalBytes: number;
}

interface BgJob extends BgJobView {
  child: ChildProcess | null;
  log: string;       // combined stdout+stderr in arrival order
  readOffset: number; // cursor for incremental reads
  trimmed: number;    // bytes dropped from the front by the rolling cap
}

export class BackgroundManager {
  private jobs = new Map<string, BgJob>();
  private seq = 0;
  private readonly maxJobs: number;

  constructor(maxJobs = 100) {
    this.maxJobs = Number.isFinite(maxJobs) && maxJobs > 0 ? Math.floor(maxJobs) : 100;
  }

  private pruneCompletedForNewJob(): void {
    if (this.jobs.size < this.maxJobs) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    while (this.jobs.size >= this.maxJobs && completed.length > 0) {
      this.jobs.delete(completed.shift()!.id);
    }
  }

  private append(job: BgJob, text: string): void {
    job.log += text;
    job.totalBytes += Buffer.byteLength(text, 'utf8');
    const bytes = Buffer.from(job.log, 'utf8');
    if (bytes.length > MAX_LOG_BYTES) {
      let start = bytes.length - MAX_LOG_BYTES;
      // Move to the first complete UTF-8 code point so the retained text never
      // begins with a replacement character after slicing a multibyte sequence.
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      const previousLength = job.log.length;
      job.log = bytes.subarray(start).toString('utf8');
      const droppedChars = previousLength - job.log.length;
      job.trimmed += start;
      job.readOffset = Math.max(0, job.readOffset - droppedChars);
    }
  }

  /** Start a background command. Returns the job id, or an error string. */
  start(command: string, opts?: { cwd?: string; env?: Record<string, string> }): { id?: string; error?: string } {
    const check = preflightCheck(command);
    if (check) return { error: `[BLOCKED] ${check}` };

    this.pruneCompletedForNewJob();

    const id = `bg_${(++this.seq).toString(36)}_${Date.now().toString(36)}`;
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd: opts?.cwd || process.cwd(),
        env: { ...process.env, ...(opts?.env || {}) },
        windowsHide: true,
      });
    } catch (e: any) {
      return { error: `Failed to start background command: ${e.message || e}` };
    }

    const job: BgJob = {
      id, command, pid: child.pid ?? null, status: 'running', exitCode: null,
      startedAt: Date.now(), endedAt: null, totalBytes: 0,
      child, log: '', readOffset: 0, trimmed: 0,
    };
    this.jobs.set(id, job);

    child.stdout?.on('data', (d) => this.append(job, d.toString()));
    child.stderr?.on('data', (d) => this.append(job, d.toString()));
    child.on('error', (e) => {
      job.status = 'error';
      job.endedAt = Date.now();
      this.append(job, `\n[spawn error] ${e.message}\n`);
      log.warn('bg_error', { id, error: e.message });
    });
    child.on('exit', (code, signal) => {
      if (job.status === 'running') job.status = signal ? 'killed' : 'exited';
      job.exitCode = code;
      job.endedAt = Date.now();
      job.child = null;
    });

    return { id };
  }

  get(id: string): BgJob | undefined { return this.jobs.get(id); }

  list(): BgJobView[] {
    return [...this.jobs.values()].map(toView).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Read output produced since the last read; advances the cursor. */
  read(id: string): { ok: boolean; text?: string; status?: BgStatus; exitCode?: number | null; error?: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: `No background job '${id}'.` };
    const chunk = job.log.slice(job.readOffset);
    job.readOffset = job.log.length;
    return { ok: true, text: chunk, status: job.status, exitCode: job.exitCode };
  }

  kill(id: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: `No background job '${id}'.` };
    if (job.status !== 'running' || !job.child) return { ok: false, error: `Job '${id}' is not running (${job.status}).` };
    const pid = job.child.pid;
    try {
      if (process.platform === 'win32' && pid) {
        // child.kill() doesn't reap the cmd.exe process tree on Windows.
        try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); }
        catch { job.child.kill(); }
      } else {
        job.child.kill('SIGTERM');
      }
      job.status = 'killed';
      job.endedAt = Date.now();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: `Failed to kill '${id}': ${e.message || e}` };
    }
  }

  /** Terminate all running jobs (called on session shutdown). */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') this.kill(job.id);
    }
  }
}

function toView(j: BgJob): BgJobView {
  return {
    id: j.id, command: j.command, pid: j.pid, status: j.status,
    exitCode: j.exitCode, startedAt: j.startedAt, endedAt: j.endedAt, totalBytes: j.totalBytes,
  };
}

let _mgr: BackgroundManager | null = null;
export function getBackgroundManager(): BackgroundManager {
  if (!_mgr) _mgr = new BackgroundManager();
  return _mgr;
}
