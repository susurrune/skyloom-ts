/**
 * Tests for agent icon system.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_COLORS, AGENT_EMOJI, iconText, svgPath } from '../src/core/icons';

describe('AGENT_COLORS', () => {
  it('has all 6 agents', () => {
    expect(Object.keys(AGENT_COLORS).sort()).toEqual(['dew', 'fair', 'fog', 'frost', 'rain', 'snow']);
  });

  it('each agent has a non-empty color', () => {
    for (const color of Object.values(AGENT_COLORS)) {
      expect(color).toBeTruthy();
    }
  });
});

describe('AGENT_EMOJI', () => {
  it('has all 6 agents', () => {
    expect(Object.keys(AGENT_EMOJI).sort()).toEqual(['dew', 'fair', 'fog', 'frost', 'rain', 'snow']);
  });

  it('unique emoji per agent', () => {
    const values = Object.values(AGENT_EMOJI);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('iconText', () => {
  it('returns glyph for known agent', () => {
    expect(iconText('fog')).toBe('≋');
    expect(iconText('fair')).toBe('☼');
  });

  it('returns name as fallback for unknown agent', () => {
    expect(iconText('unknown')).toBe('unknown');
  });
});

describe('svgPath', () => {
  it('returns a path ending with .svg', () => {
    expect(svgPath('fog')).toContain('icons');
  });
});
