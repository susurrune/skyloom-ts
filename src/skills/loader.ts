/**
 * Skill loader — registers all built-in skills from skill definition files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SkillRegistry } from '../core/skill';
import { getLogger } from '../core/logger';

const log = getLogger('skills-loader');

// Built-in skill directories to scan
const BUILTIN_SKILL_DIRS = [
  path.join(__dirname, '..', '..', 'config', 'skills'),
  path.join(__dirname, '..', '..', 'assets', 'builtin_skills'),
];

/**
 * Register all available skills from built-in directories.
 */
export function registerAllSkills(registry: SkillRegistry): void {
  for (const dir of BUILTIN_SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const skillDir = path.join(dir, entry);
        if (!fs.statSync(skillDir).isDirectory()) continue;

        const skillFile = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        const skill = registry.loadSkillsFromDirectory(skillDir);
        if (skill.length > 0) {
          log.debug('registered_skill', { name: entry, file: skillFile });
        }
      }
    } catch (e) {
      log.warn('skill_load_failed', { dir, error: String(e) });
    }
  }

  const count = registry.listNames().length;
  log.info('skills_loaded', { count });
}
