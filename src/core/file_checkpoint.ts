/**
 * 文件级检查点 — snapshot files before agents mutate them; /rewind restores.
 *
 * Every chat turn / task opens a checkpoint "turn". Before write_file /
 * edit_file / delete_file executes, the target's current content (or its
 * absence) is snapshotted — first touch per path per turn wins, so a rewind
 * restores the state from *before* the turn began. Lets users hand agents
 * risky changes and undo them in one command, without involving git.
 *
 * Deliberately session-scoped and in-memory (like Claude Code checkpoints):
 * not a git replacement, and `run_bash` side effects cannot be rewound.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';

const log = getLogger('checkpoint');

interface FileSnapshot {
  /** Absolute path. */
  path: string;
  /** Content before the turn, or null if the file did not exist. */
  content: string | null;
}

export interface CheckpointTurn {
  id: number;
  label: string;
  at: Date;
  snapshots: Map<string, FileSnapshot>;
}

const MAX_TURNS = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip snapshotting monsters
const MUTATING_TOOL_RE = /^(write_file|edit_file|delete_file)$/;

class FileCheckpointStore {
  private turns: CheckpointTurn[] = [];
  private current: CheckpointTurn | null = null;
  private redoStack: CheckpointTurn[] = [];
  private seq = 0;

  /** Open a new turn; subsequent snapshots attach to it. */
  beginTurn(label: string): void {
    // An empty previous turn is replaced, not stacked.
    if (this.current && this.current.snapshots.size === 0) {
      this.turns.pop();
    }
    this.current = { id: ++this.seq, label: label.slice(0, 60), at: new Date(), snapshots: new Map() };
    this.turns.push(this.current);
    if (this.turns.length > MAX_TURNS) this.turns.shift();
  }

  /** Snapshot a path before mutation (first touch per turn wins). */
  snapshot(rawPath: string): void {
    if (!this.current) this.beginTurn('(implicit)');
    const abs = path.resolve(rawPath);
    if (this.current!.snapshots.has(abs)) return;
    let content: string | null = null;
    try {
      if (fs.existsSync(abs)) {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
        content = fs.readFileSync(abs, 'utf-8');
      }
    } catch (e) {
      log.warn('snapshot_failed', { path: abs, error: String(e) });
      return;
    }
    this.current!.snapshots.set(abs, { path: abs, content });
  }

  /** Should this tool call be snapshotted? Returns the path to snapshot. */
  pathToSnapshot(toolName: string, args: Record<string, any>): string | null {
    if (!MUTATING_TOOL_RE.test(toolName)) return null;
    const p = args?.path;
    return typeof p === 'string' && p.trim() ? p : null;
  }

  /** Turns that actually captured changes, newest first. */
  list(): Array<{ id: number; label: string; at: Date; files: string[] }> {
    return this.turns
      .filter(t => t.snapshots.size > 0)
      .map(t => ({ id: t.id, label: t.label, at: t.at, files: [...t.snapshots.keys()] }))
      .reverse();
  }

  /**
   * Restore the last `count` non-empty turns (newest backwards). When the
   * same file appears in several turns, the oldest snapshot wins — that is
   * the state from before the earliest rewound turn.
   */
  rewind(count: number = 1): { restored: string[]; deleted: string[]; turns: number } {
    const nonEmpty = this.turns.filter(t => t.snapshots.size > 0);
    const target = nonEmpty.slice(-count);
    if (target.length === 0) return { restored: [], deleted: [], turns: 0 };

    // oldest-first iteration: later assignments overwrite, so the oldest
    // snapshot per path ends up in the map
    const finalState = new Map<string, FileSnapshot>();
    for (let i = target.length - 1; i >= 0; i--) {
      for (const snap of target[i].snapshots.values()) finalState.set(snap.path, snap);
    }

    const restored: string[] = [];
    const deleted: string[] = [];
    for (const snap of finalState.values()) {
      try {
        if (snap.content === null) {
          if (fs.existsSync(snap.path)) { fs.unlinkSync(snap.path); deleted.push(snap.path); }
        } else {
          fs.mkdirSync(path.dirname(snap.path), { recursive: true });
          fs.writeFileSync(snap.path, snap.content, 'utf-8');
          restored.push(snap.path);
        }
      } catch (e) {
        log.warn('rewind_failed', { path: snap.path, error: String(e) });
      }
    }

    // Rewound turns are consumed and pushed to redo stack.
    const ids = new Set(target.map(t => t.id));
    const rewoundTurns = this.turns.filter(t => ids.has(t.id));
    this.turns = this.turns.filter(t => !ids.has(t.id));
    if (this.current && ids.has(this.current.id)) this.current = null;
    this.redoStack.push(...rewoundTurns.reverse());
    return { restored, deleted, turns: target.length };
  }

  /**
   * Redo the last undone turns. Restores files to their post-rewind state.
   */
  redo(): { restored: string[]; deleted: string[]; turns: number } {
    if (this.redoStack.length === 0) return { restored: [], deleted: [], turns: 0 };
    const target = [this.redoStack.pop()!];
    const restored: string[] = [];
    const deleted: string[] = [];
    for (const snap of target[0].snapshots.values()) {
      try {
        if (snap.content === null) {
          if (fs.existsSync(snap.path)) { fs.unlinkSync(snap.path); deleted.push(snap.path); }
        } else {
          fs.mkdirSync(path.dirname(snap.path), { recursive: true });
          fs.writeFileSync(snap.path, snap.content, 'utf-8');
          restored.push(snap.path);
        }
      } catch (e) {
        log.warn('redo_failed', { path: snap.path, error: String(e) });
      }
    }
    return { restored, deleted, turns: target.length };
  }

  /** Test/reset hook. */
  clear(): void { this.turns = []; this.current = null; }
}

let _store: FileCheckpointStore | null = null;
export function getFileCheckpoints(): FileCheckpointStore {
  if (!_store) _store = new FileCheckpointStore();
  return _store;
}
