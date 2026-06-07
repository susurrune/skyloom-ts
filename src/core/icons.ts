/**
 * Agent icon system — dynamic status indicators.
 *
 * Each agent is identified by its display name with color styling.
 * During processing, agent spinners provide dynamic status.
 */

import * as path from 'path';

const ICONS_DIR = path.resolve(__dirname, '..', 'assets', 'icons');

export const AGENT_COLORS: Record<string, string> = {
  fog: 'bright_white',
  rain: 'blue',
  frost: 'cyan',
  snow: 'bright_white',
  dew: 'green',
  fair: '#FFD700',
};

export const AGENT_EMOJI: Record<string, string> = {
  fog: '≋',
  rain: '⸽',
  frost: '✱',
  snow: '❉',
  dew: '∘',
  fair: '☼',
};

/**
 * Return the filesystem path to an agent's SVG icon file.
 */
export function svgPath(name: string): string {
  return path.join(ICONS_DIR, `${name}.svg`);
}

/**
 * Return the plain-text icon for an agent.
 *
 * Used in dashboards, prompts, logs, and any UI where SVG can't render.
 * The glyphs are deliberately chosen from Unicode blocks that render
 * as monochrome text on virtually every terminal.
 *
 *   fog  ≋  three wavy lines — drifting mist
 *   rain ⸽  six vertical dots — falling rain streaks
 *   frost ✱  pointed asterisk — frost crystal
 *   snow ❉  balloon-spoked star — snowflake
 *   dew  ∘  ring — dewdrop
 *   fair ☼  sun with rays — clear sky
 */
export function iconText(name: string): string {
  return AGENT_EMOJI[name] ?? name;
}
