import { buildTasksFromPipeline, matchPipeline, validateDAG } from '../core/pipelines';
import { classify, type Mode, pickAgentForGoal } from '../core/router';
import { ToolRegistry } from '../core/tool';
import { selectRelevantTools } from '../core/tool_router';

export type EvalSuite = 'routing' | 'agent-routing' | 'pipeline' | 'tool-routing';

export interface EvalCaseResult {
  id: string;
  suite: EvalSuite;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface EvalReport {
  schemaVersion: 1;
  generatedAt: string;
  aggregate: {
    total: number;
    passed: number;
    passRate: number;
  };
  suites: Record<EvalSuite, { total: number; passed: number; passRate: number }>;
  cases: EvalCaseResult[];
}

const AGENTS = new Set(['fog', 'rain', 'frost', 'snow', 'dew', 'fair']);

const ROUTING_CASES: Array<{ id: string; input: string; expected: Mode }> = [
  { id: 'route-greeting-zh', input: '你好', expected: 'direct' },
  { id: 'route-question-en', input: 'What is an event loop?', expected: 'direct' },
  { id: 'route-file-task', input: '修复 D:/repo/src/main.ts 中的类型错误', expected: 'single' },
  { id: 'route-url-task', input: '总结 https://example.com/spec', expected: 'single' },
  { id: 'route-inline-plan', input: '1. 调研现状 2. 设计方案 3. 实现并验证', expected: 'orchestrate' },
  { id: 'route-sequence-zh', input: '先分析需求，然后实现，最后审查结果', expected: 'orchestrate' },
];

const AGENT_CASES = [
  { id: 'agent-research', input: '调研最新的数据库方案', expected: 'fog' },
  { id: 'agent-implementation', input: '实现一个二分查找函数', expected: 'rain' },
  { id: 'agent-review', input: '审查这段代码的安全漏洞', expected: 'frost' },
  { id: 'agent-operations', input: '检查 CI 部署环境变量', expected: 'dew' },
  { id: 'agent-companion', input: '我今天很难过，陪我聊聊', expected: 'fair' },
];

const PIPELINE_CASES = [
  { id: 'pipeline-review', input: '请进行代码审查', expected: 'code_review' },
  { id: 'pipeline-research-write', input: '先调研再写一份报告', expected: 'research_then_write' },
  { id: 'pipeline-fix-verify', input: '修复并验证这个 bug', expected: 'fix_and_verify' },
  { id: 'pipeline-none', input: '解释一下闭包是什么', expected: null },
];

const TOOL_SPECS: Array<[string, string]> = [
  ['read_file', 'read a file from disk'],
  ['write_file', 'write content to a file'],
  ['edit_file', 'edit an existing file'],
  ['web_search', 'search the live web for current information'],
  ['read_url', 'read a web page'],
  ['git_diff', 'inspect git changes'],
  ['git_commit', 'commit changes to git'],
  ['get_diagnostics', 'get TypeScript diagnostics'],
  ['run_bash', 'run a shell command'],
  ['list_skills', 'list available skills'],
  ['use_skill', 'activate a skill'],
  ['recall_facts', 'recall memory facts'],
  ['remember_fact', 'remember a fact'],
  ['delegate_to', 'delegate work to another agent'],
  ...Array.from({ length: 16 }, (_, i): [string, string] => [`synthetic_${i}`, `unrelated synthetic capability ${i}`]),
];

const TOOL_CASES = [
  { id: 'tool-live-search', input: '查询今天最新的 AI 新闻', required: ['web_search'] },
  { id: 'tool-file-fix', input: '读取并修复这个 TypeScript 文件', required: ['read_file', 'edit_file'] },
  { id: 'tool-git-review', input: '查看 git diff 并审查修改', required: ['git_diff'] },
  { id: 'tool-skill', input: '查找并使用合适的 PDF skill', required: ['list_skills', 'use_skill'] },
];

function result(id: string, suite: EvalSuite, expected: unknown, actual: unknown, passed: boolean): EvalCaseResult {
  return { id, suite, expected, actual, passed };
}

function makeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, description] of TOOL_SPECS) {
    registry.register({ name, description, handler: async () => 'ok' });
  }
  return registry;
}

export function runBaselineEvals(now: () => Date = () => new Date()): EvalReport {
  const cases: EvalCaseResult[] = [];

  for (const c of ROUTING_CASES) {
    const actual = classify(c.input);
    cases.push(result(c.id, 'routing', c.expected, actual, actual === c.expected));
  }
  for (const c of AGENT_CASES) {
    const actual = pickAgentForGoal(c.input, AGENTS);
    cases.push(result(c.id, 'agent-routing', c.expected, actual, actual === c.expected));
  }
  for (const c of PIPELINE_CASES) {
    const matched = matchPipeline(c.input);
    const actual = matched?.name ?? null;
    const dagValid = matched ? validateDAG(buildTasksFromPipeline(matched, c.input)).valid : true;
    cases.push(result(c.id, 'pipeline', c.expected, actual, actual === c.expected && dagValid));
  }

  const registry = makeToolRegistry();
  const names = registry.listNames();
  for (const c of TOOL_CASES) {
    const selected = selectRelevantTools(registry, names, c.input, { topK: 10 });
    const missing = c.required.filter(name => !selected.includes(name));
    cases.push(result(c.id, 'tool-routing', c.required, selected, missing.length === 0));
  }

  const suiteNames: EvalSuite[] = ['routing', 'agent-routing', 'pipeline', 'tool-routing'];
  const suites = Object.fromEntries(suiteNames.map(suite => {
    const selected = cases.filter(c => c.suite === suite);
    const passed = selected.filter(c => c.passed).length;
    return [suite, { total: selected.length, passed, passRate: selected.length ? passed / selected.length : 1 }];
  })) as EvalReport['suites'];
  const passed = cases.filter(c => c.passed).length;
  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    aggregate: { total: cases.length, passed, passRate: cases.length ? passed / cases.length : 1 },
    suites,
    cases,
  };
}
