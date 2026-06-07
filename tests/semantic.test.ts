/**
 * Tests for lightweight semantic retrieval.
 */
import { describe, it, expect } from 'vitest';
import { SemanticScorer, getScorer } from '../src/core/semantic';

describe('SemanticScorer', () => {
  const scorer = new SemanticScorer();

  it('identical strings score 1.0', () => {
    expect(scorer.similarity('hello world', 'hello world')).toBe(1.0);
  });

  it('completely different strings score 0.0', () => {
    expect(scorer.similarity('aaaaa', 'bbbbb')).toBe(0.0);
  });

  it('partial overlap scores between 0 and 1', () => {
    const score = scorer.similarity('deploy to server', 'deployment script');
    expect(score).toBeGreaterThan(0.0);
    expect(score).toBeLessThan(1.0);
  });

  it('CJK similarity works', () => {
    const score = scorer.similarity('部署', '部署命令');
    expect(score).toBeGreaterThan(0.0);
  });

  it('empty strings return 0', () => {
    expect(scorer.similarity('', 'hello')).toBe(0.0);
    expect(scorer.similarity('hello', '')).toBe(0.0);
    expect(scorer.similarity('', '')).toBe(0.0);
  });

  it('case insensitive', () => {
    expect(scorer.similarity('Hello World', 'hello world')).toBe(1.0);
  });

  it('mixed language overlap', () => {
    const score = scorer.similarity('pnpm install', 'pnpm 安装');
    expect(score).toBeGreaterThan(0.0);
  });

  it('code identifiers match partially', () => {
    const score = scorer.similarity('snake_case_var', 'snakeCaseVar');
    expect(score).toBeGreaterThan(0.0);
  });

  it('rank returns ordered results', () => {
    const candidates = [
      { key: 'k1', value: 'deploy to production' },
      { key: 'k2', value: 'install dependencies' },
      { key: 'k3', value: 'rollback version' },
    ];
    const ranked = scorer.rank('deploy', candidates, 'value', 2);
    expect(ranked.length).toBeLessThanOrEqual(2);
    expect(ranked[0][1].key).toBe('k1');
  });

  it('rank filters below minScore', () => {
    const candidates = [
      { key: 'k1', value: 'completely unrelated text here' },
    ];
    const ranked = scorer.rank('zzzzz', candidates, 'value', 1, 0.5);
    expect(ranked).toHaveLength(0);
  });

  it('rank uses key field boost', () => {
    const candidates = [
      { key: 'deploy_command', value: 'npm run build' },
    ];
    const ranked = scorer.rank('deploy', candidates, 'value', 1);
    expect(ranked).toHaveLength(1);
  });
});

describe('getScorer singleton', () => {
  it('returns the same instance', () => {
    const s1 = getScorer();
    const s2 = getScorer();
    expect(s1).toBe(s2);
  });
});
