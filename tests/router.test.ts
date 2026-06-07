/**
 * Tests for the complexity router.
 */
import { describe, it, expect } from 'vitest';
import { classify, pickAgentForGoal } from '../src/core/router';

describe('classify', () => {
  it.each([
    '你好',
    'hi',
    '在吗',
    '谢谢',
    '什么是 RAG?',
    '为什么天空是蓝的？',
    '1 + 1 = ?',
    '解释一下闭包',
  ])('returns "direct" for simple questions: %s', (goal) => {
    expect(classify(goal)).toBe('direct');
  });

  it.each([
    '帮我写一个二分查找函数',
    '搜一下今天的天气',
    '审查 src/foo.py 的安全问题',
    '把这段中文翻译成英文：我喜欢猫',
  ])('returns "single" for focused tasks: %s', (goal) => {
    expect(classify(goal)).toBe('single');
  });

  it.each([
    '先帮我分析这段代码，然后重构它，最后写测试',
    '首先调研一下市场上有哪些方案，其次对比性能，最后给出推荐',
    '1. 创建数据库迁移\n2. 写 API\n3. 加测试\n4. 部署',
  ])('returns "orchestrate" for multi-step: %s', (goal) => {
    expect(classify(goal)).toBe('orchestrate');
  });

  it('empty goal returns direct', () => {
    expect(classify('')).toBe('direct');
    expect(classify('   ')).toBe('direct');
  });

  it('inline enumerated list is orchestrate', () => {
    expect(classify('1. 拉数据 2. 分析 3. 出图')).toBe('orchestrate');
    expect(classify('先做 1. xxx 2. yyy 3. zzz 4. www')).toBe('orchestrate');
  });

  it('two inline items is not orchestrate', () => {
    expect(classify('1. 你好 2. 谢谢')).not.toBe('orchestrate');
  });
});

describe('pickAgentForGoal', () => {
  const allAgents = new Set(['fog', 'rain', 'frost', 'snow', 'dew', 'fair']);

  it('security keyword picks frost', () => {
    expect(pickAgentForGoal('帮我做安全审查', allAgents)).toBe('frost');
  });

  it('research keyword picks fog', () => {
    expect(pickAgentForGoal('搜一下最新的 React 文档', allAgents)).toBe('fog');
  });

  it('greeting picks fair', () => {
    expect(pickAgentForGoal('你好啊', allAgents)).toBe('fair');
  });

  it('falls back to rain', () => {
    expect(pickAgentForGoal('处理这个东西', allAgents)).toBe('rain');
  });

  it('binary search picks rain not fog', () => {
    expect(pickAgentForGoal('帮我写一个二分查找', allAgents)).toBe('rain');
    expect(pickAgentForGoal('实现一个排序函数', allAgents)).toBe('rain');
  });

  it('skips missing agents', () => {
    const available = new Set(['rain', 'snow']);
    const result = pickAgentForGoal('做安全审查', available);
    expect(available.has(result)).toBe(true);
  });

  it('single agent available', () => {
    expect(pickAgentForGoal('anything', new Set(['rain']))).toBe('rain');
  });
});
