/**
 * Orchestration checkpoint — save/restore task state.
 *
 * Writes ~/.skyloom/task_checkpoint.json so a long-running orchestration
 * interrupted by Ctrl-C can be resumed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { USER_CONFIG_DIR } from './config';

function checkpointPath(): string {
  return path.join(USER_CONFIG_DIR, 'task_checkpoint.json');
}

/**
 * Save current orchestration state so it can be resumed later.
 */
export function save(
  goal: string,
  tasks: any[],
  results: any[],
  completedIds?: Set<string>
): void {
  const cids = completedIds || new Set(results.map((r: any) => r.id));
  const payload = {
    goal,
    tasks: tasks.map(serializeTask),
    results: results.map(serializeResult),
    completed_ids: Array.from(cids).sort(),
  };

  const p = checkpointPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * Return the last saved checkpoint dict, or null if none / unreadable.
 */
export function load(): Record<string, any> | null {
  const p = checkpointPath();
  if (!fs.existsSync(p)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return typeof data === 'object' && data !== null ? data : null;
  } catch {
    return null;
  }
}

/**
 * Delete the checkpoint file.
 */
export function clear(): void {
  try {
    const p = checkpointPath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ── Serialization helpers ──

function serializeTask(t: any): Record<string, any> {
  return {
    id: t.id,
    description: t.description,
    assigned_to: t.assignedTo ?? t.assigned_to,
    all_deps: t.allDeps ?? t.all_deps ?? [],
    status: t.status?.value ?? t.status ?? 'unknown',
  };
}

function serializeResult(r: any): Record<string, any> {
  return {
    id: r.id,
    agent: r.agent,
    description: r.description,
    success: r.success,
    content: r.content,
  };
}
