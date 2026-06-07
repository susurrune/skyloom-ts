/**
 * Complexity router: classify a user goal into direct / single / orchestrate.
 *
 * Rules-first (no LLM), so classification stays under 1ms. The router exists
 * solely to keep simple goals from triggering Snow's full task-decomposition
 * LLM call when a single agent could answer in one shot.
 */

export type Mode = 'direct' | 'single' | 'orchestrate';

const MULTI_STEP_TOKENS = [
  '先', '再', '然后', '接着', '之后', '其次', '最后',
  '第一步', '第二步', '第三步', '步骤', '顺序', '依次', '首先',
  'step 1', 'step 2', 'first,', 'then,', 'after that', 'finally',
];

const GREETING_TOKENS = [
  '你好', '您好', 'hi', 'hello', 'hey', '在吗', '嗨',
  '早上好', '晚安', '谢谢', 'thanks', 'thank you', '再见', 'bye',
];

const SINGLE_ACTION_HINTS = [
  '解释', '什么是', '为什么', '如何', '怎么', '查询', '搜索',
  '搜一下', '翻译', '总结', 'summarize', 'explain', 'what is', 'why', 'how do',
];

const ACTION_VERBS = [
  '写', '帮我写', '生成', '创建', '实现', '做', '搜', '查',
  '找', '审查', '审计', '翻译', '重构', '修改', '改', '部署',
  '运行', '执行',
  'write', 'create', 'generate', 'implement', 'search', 'find',
  'review', 'translate', 'deploy', 'run',
];

const CODE_BLOCK = /```[\s\S]+?```/;
const URL_PATTERN = /https?:\/\/\S+/;
const PATH_PATTERN = /(?:[A-Za-z]:[\\/]|[\\/])[\w\-./\\]+/;
const NUMBERED_LIST = /(?:^|\n)\s*(?:\d+[.)、]|[-*])\s+/gm;
const INLINE_ENUMERATED = /\b\d+[.)、]\s*\S/g;

/**
 * Decide the execution mode for a user goal.
 *
 * direct: short greeting / single factual question, no tools needed.
 * single: clear single-purpose task, one agent + tools.
 * orchestrate: multi-step plan worth decomposing into sub-tasks.
 */
export function classify(goal: string): Mode {
  if (!goal || !goal.trim()) return 'direct';

  const text = goal.trim();
  const lower = text.toLowerCase();
  const length = text.length;

  const hasCode = CODE_BLOCK.test(text);
  const hasUrl = URL_PATTERN.test(text);
  const hasPath = PATH_PATTERN.test(text);
  const listMatches = (text.match(NUMBERED_LIST) || []).length;
  const inlineEnumHits = (text.match(INLINE_ENUMERATED) || []).length;

  const multiStepHits = MULTI_STEP_TOKENS.filter(t => lower.includes(t)).length;
  const greetingHits = GREETING_TOKENS.filter(t => lower.includes(t)).length;
  const singleHits = SINGLE_ACTION_HINTS.filter(t => lower.includes(t)).length;
  const actionHits = ACTION_VERBS.filter(t => lower.includes(t)).length;

  if (greetingHits >= 1 && length < 30 && multiStepHits === 0 && actionHits === 0) {
    return 'direct';
  }

  if (multiStepHits >= 2 || listMatches >= 2 || inlineEnumHits >= 3) {
    return 'orchestrate';
  }

  if (length > 200 && multiStepHits >= 1) {
    return 'orchestrate';
  }

  if (hasCode && length > 150) {
    return 'orchestrate';
  }

  // Tool-use signals push toward single, not direct
  if (hasPath || hasUrl || actionHits >= 1) {
    return 'single';
  }

  if (length < 50 && !hasCode) {
    if (singleHits >= 1 || text.endsWith('?') || text.endsWith('？')) {
      return 'direct';
    }
    if (multiStepHits === 0) {
      return 'direct';
    }
  }

  return 'single';
}

/**
 * Pick a single agent for a non-orchestrate goal, by keyword routing.
 *
 * Returns an agent name guaranteed to be in available, falling back to
 * rain (generation generalist) then to any available agent.
 */
export function pickAgentForGoal(goal: string, available: Set<string>): string {
  const lower = goal.toLowerCase();

  // More specific buckets first
  const buckets: Array<[string, string[]]> = [
    ['frost', ['审查', 'review', '漏洞', '安全', '审计', 'lint', '重构建议', 'code smell']],
    ['dew', ['部署', '运行', '执行命令', 'shell', 'deploy', 'ci', 'cd', '环境变量', '运维']],
    ['fog', ['研究', '调研', '搜一下', '搜索', '查一下', '查资料', 'research', 'search', '调查', '找一下', '找资料']],
    ['rain', ['写', '生成', '实现', 'create', 'generate', '写一段', '写个', '代码', '函数', '实现一个']],
    ['fair', ['陪我', '聊天', '心情', '难过', '开心', '孤独', '倾诉', '你好', 'hi', 'hello', '嗨']],
  ];

  for (const [agent, hints] of buckets) {
    if (!available.has(agent)) continue;
    if (hints.some(h => lower.includes(h))) return agent;
  }

  if (available.has('rain')) return 'rain';
  return Array.from(available)[0];
}
