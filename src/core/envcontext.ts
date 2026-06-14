/**
 * Environment context snapshot — a small, model-visible block describing the
 * runtime world (working directory, platform, git, Node, date), kept separate
 * from conversation history. Mirrors Claude Code's <env> block so the agent
 * grounds itself without having to probe with tools every turn.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GitInfo {
  repo: boolean;
  branch?: string;
}

/**
 * Cheap git detection: walk up for a `.git` (handles worktrees, where `.git`
 * is a file pointing at the real gitdir), then read HEAD for the branch. No
 * subprocess — just file reads.
 */
export function gitInfo(cwd: string = process.cwd()): GitInfo {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(dir, '.git');
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit;
      try {
        if (fs.statSync(dotGit).isFile()) {
          const m = fs.readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+)/);
          if (m) gitDir = path.resolve(dir, m[1].trim());
        }
      } catch { /* treat as repo without branch */ }
      try {
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/ref:\s*refs\/heads\/(.+)/);
        return { repo: true, branch: ref ? ref[1] : head.slice(0, 8) };
      } catch {
        return { repo: true };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { repo: false };
}

/**
 * Build the environment block. `now` is injectable for deterministic tests.
 */
export function buildEnvBlock(opts?: { cwd?: string; lang?: string; now?: Date }): string {
  const cwd = opts?.cwd || process.cwd();
  const lang = opts?.lang || 'zh';
  const now = opts?.now || new Date();
  const git = gitInfo(cwd);
  const date = now.toISOString().slice(0, 10);
  const platform = `${process.platform} ${os.release()}`;
  const gitLine = git.repo ? (git.branch ? `yes (branch: ${git.branch})` : 'yes') : 'no';

  if (lang === 'en') {
    return [
      '## Environment',
      `- Working directory: ${cwd}`,
      `- Platform: ${platform}`,
      `- Node: ${process.version}`,
      `- Git repo: ${gitLine}`,
      `- Date: ${date}`,
    ].join('\n');
  }
  return [
    '## 运行环境',
    `- 工作目录: ${cwd}`,
    `- 平台: ${platform}`,
    `- Node: ${process.version}`,
    `- Git 仓库: ${gitLine === 'no' ? '否' : gitLine.replace('yes', '是')}`,
    `- 日期: ${date}`,
  ].join('\n');
}
