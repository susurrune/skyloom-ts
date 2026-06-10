/**
 * Skill loader — built-in skills plus user/project skill discovery.
 *
 * Discovery order (later registration wins, so project beats user beats
 * built-in when names collide):
 *   1. built-in:  config/skills/, assets/builtin_skills/
 *   2. user:      ~/.claude/skills/  (Claude Code compatible — zero-copy
 *                 migration), then ~/.skyloom/skills/  (native)
 *   3. project:   <cwd>/.claude/skills/, then <cwd>/.sky/skills/
 *
 * All locations use the same folder layout as Claude Code:
 *   <root>/<skill-name>/SKILL.md  (+ optional reference files / scripts)
 * Frontmatter is Claude Code compatible (name / description /
 * allowed-tools — tool names like `bash`/`read` are aliased to sky tools).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillRegistry } from '../core/skill';
import { getLogger } from '../core/logger';

const log = getLogger('skills-loader');

// Built-in skill directories to scan
const BUILTIN_SKILL_DIRS = [
  path.join(__dirname, '..', '..', 'config', 'skills'),
  path.join(__dirname, '..', '..', 'assets', 'builtin_skills'),
];

/** User/project skill roots, lowest precedence first. */
export function dynamicSkillDirs(cwd: string = process.cwd()): string[] {
  return [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.skyloom', 'skills'),
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.sky', 'skills'),
  ];
}

/**
 * (Re)scan user/project skill folders. Cheap enough to call on demand —
 * list_skills triggers it, so edits to SKILL.md files apply live without
 * restarting the session.
 */
export function registerDynamicSkills(registry: SkillRegistry, cwd: string = process.cwd()): number {
  let count = 0;
  for (const dir of dynamicSkillDirs(cwd)) {
    try {
      count += registry.loadSkillFolders(dir).length;
    } catch (e) {
      log.warn('dynamic_skill_load_failed', { dir, error: String(e) });
    }
  }
  return count;
}

/**
 * Register all available skills: built-ins, then user/project overlays.
 */
export function registerAllSkills(registry: SkillRegistry): void {
  for (const dir of BUILTIN_SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      registry.loadSkillFolders(dir);
    } catch (e) {
      log.warn('skill_load_failed', { dir, error: String(e) });
    }
  }

  registerDynamicSkills(registry);

  const count = registry.listNames().length;
  log.info('skills_loaded', { count });
}
