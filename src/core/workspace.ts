/**
 * Workspace auto-detection and lifecycle management.
 *
 * Rules:
 * - First launch: auto-select best drive, create workspace/
 * - Multi-drive: skip C:, pick drive with most free space
 * - Single drive (C: only): use C:\\workspace
 * - Unix: use ~/workspace
 * - User can override via config workspace.path
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKSPACE_SUBDIRS = ['files', 'output', 'temp'];

export interface DriveInfo {
  letter: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
}

/**
 * Enumerate fixed drives with free-space info.
 */
function getDriveList(): DriveInfo[] {
  const drives: DriveInfo[] = [];

  if (process.platform === 'win32') {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i); // A-Z
      const root = `${letter}:\\`;
      if (!fs.existsSync(root)) continue;
      try {
        const stat = fs.statfsSync(root);
        drives.push({
          letter,
          path: root,
          totalBytes: stat.blocks * stat.bsize,
          freeBytes: stat.bfree * stat.bsize,
        });
      } catch {
        try {
          // Fallback: just mark it available
          drives.push({
            letter,
            path: root,
            totalBytes: 0,
            freeBytes: 0,
          });
        } catch {
          continue;
        }
      }
    }
  } else {
    // Unix — treat / as the single candidate
    try {
      const stat = fs.statfsSync('/');
      drives.push({
        letter: '',
        path: '/',
        totalBytes: stat.blocks * stat.bsize,
        freeBytes: stat.bfree * stat.bsize,
      });
    } catch {
      // Ignore
    }
  }

  return drives;
}

/**
 * Pick the best drive for the workspace directory.
 *
 * - Windows with multiple drives: skip C:, pick drive with most free bytes.
 * - Windows with only C: → C:\\workspace.
 * - Unix → ~/workspace.
 */
export function detectBestWorkspaceRoot(): string {
  const drives = getDriveList();

  if (process.platform === 'win32') {
    let candidates = drives.filter((d) => d.letter.toUpperCase() !== 'C');
    if (candidates.length === 0) {
      candidates = drives; // fallback to C:
    }
    // Sort by free space descending
    candidates.sort((a, b) => b.freeBytes - a.freeBytes);
    const best = candidates[0];
    return path.join(best.path, 'workspace');
  } else {
    return path.join(os.homedir(), 'workspace');
  }
}

/**
 * Resolve workspace path from config.
 *
 * - "auto" → call detectBestWorkspaceRoot()
 * - explicit path → expand ~ and return
 */
export function resolveWorkspacePath(configValue: string): string {
  if (configValue.toLowerCase() === 'auto') {
    return detectBestWorkspaceRoot();
  }
  return path.resolve(configValue.replace(/^~/, os.homedir()));
}

/**
 * Create workspace directory tree on first use. Idempotent.
 *
 * Creates:
 *   workspace/
 *   ├── files/    # agent-generated files
 *   ├── output/   # task results, exports
 *   └── temp/     # scratch / ephemeral
 *
 * Returns the resolved workspace root path.
 */
export function initWorkspace(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  for (const sub of WORKSPACE_SUBDIRS) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  // Touch a .workspace marker so tools can identify it
  const marker = path.join(root, '.workspace');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, `# Skyloom workspace — created automatically\npath: ${root}\n`, 'utf-8');
  }
  return root;
}

/**
 * Human-readable byte count (e.g. 128.5 GB).
 */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = n;
  for (const unit of units) {
    if (Math.abs(val) < 1024.0) {
      return `${val.toFixed(1)} ${unit}`;
    }
    val /= 1024.0;
  }
  return `${val.toFixed(1)} PB`;
}
