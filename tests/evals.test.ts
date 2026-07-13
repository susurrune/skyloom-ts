import { describe, expect, it } from 'vitest';
import { runBaselineEvals } from '../src/evals/baseline';

describe('enterprise agent evaluation baseline', () => {
  it('meets every deterministic routing, pipeline and tool-selection contract', () => {
    const report = runBaselineEvals(() => new Date('2026-01-01T00:00:00.000Z'));
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.aggregate.total).toBeGreaterThanOrEqual(19);
    expect(report.cases.filter(c => !c.passed)).toEqual([]);
    expect(report.aggregate.passRate).toBe(1);
    expect(Object.values(report.suites).every(suite => suite.passRate === 1)).toBe(true);
  });
});
