/**
 * Tool-subset selection for LLM calls.
 *
 * Without filtering, every chat turn ships ~50 tool schemas (built-ins + MCP +
 * skill-required + delegation) to the model. That dilutes attention (the LLM
 * picks plausible-but-wrong tools more often) and burns 8-15k input tokens per
 * turn. This module narrows the active tool set to ~12 by lightweight scoring
 * against the user's latest message.
 *
 * The router intentionally avoids embeddings / LLM calls — it must run in <1ms
 * on every turn, before the real LLM call. A coarse keyword/substring score is
 * good enough to keep the right tools in and bad enough to be cheap.
 */

import type { ToolDefinition, ToolRegistry } from './tool';

// Infrastructure tools that are useful on most turns.
const INFRA_TOOLS: ReadonlySet<string> = new Set([
  'delegate_to',
  'list_skills',
  'use_skill',
  'recall_facts',
  'remember_fact',
]);

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'move_file',
  'copy_file',
  'delete_file',
  'git_add',
  'git_commit',
  'git_checkout',
  'shell_exec',
  'http_post',
  'mcp_add_server',
  'mcp_remove_server',
  'mcp_scaffold_server',
  'kill_process',
  'package_manager',
  'service_control',
]);

const TOKEN_RE = /[A-Za-z][A-Za-z0-9_]*|[一-鿿]+/g;

const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'and', 'or', 'but',
  'to', 'for', 'of', 'in', 'on', 'at', 'with', 'by', 'do', 'did',
  'does', 'i', 'me', 'my', 'you', 'your', 'it', 'this', 'that',
  'what', 'how', 'can', 'could', 'would', 'should', 'please',
  'tell', 'show', 'help', 'ok', 'yes', 'no',
  '好', '的', '是', '我', '你', '他', '她', '它', '这', '那',
  '什么', '怎么', '请', '帮', '麻烦',
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text?.toLowerCase().match(TOKEN_RE) || [];
  for (const t of matches) {
    if (t.length >= 2 && !STOPWORDS.has(t)) {
      tokens.add(t);
    }
  }
  return tokens;
}

function scoreTool(tool: ToolDefinition, queryTokens: Set<string>, queryLc: string): number {
  if (queryTokens.size === 0) return 0;
  let score = 0;

  // Tool name tokens carry the strongest signal
  const nameTokens = tokenize(tool.name.replace(/_/g, ' '));
  for (const qt of queryTokens) {
    if (nameTokens.has(qt)) {
      score += 5;
    } else if (tool.name.toLowerCase().includes(qt)) {
      score += 3;
    }
  }

  // Description tokens are weaker
  const descTokens = tokenize(tool.description);
  for (const qt of queryTokens) {
    if (descTokens.has(qt)) {
      score += 1;
    }
  }

  // Intent boosts for common Chinese/English tasks
  const name = tool.name;
  if (['read_file', 'list_directory', 'tree', 'file_search', 'code_search', 'grep'].includes(name) &&
    ['read', 'file', 'inspect', 'search', 'grep', '看', '读', '查', '搜索', '文件', '代码'].some(k => queryLc.includes(k))) {
    score += 4;
  }
  if (['write_file', 'edit_file', 'move_file', 'copy_file', 'delete_file'].includes(name) &&
    ['write', 'edit', 'modify', 'fix', 'save', '生成', '写', '改', '修复', '保存', '删除'].some(k => queryLc.includes(k))) {
    score += 4;
  }
  if (name.startsWith('git_') &&
    ['git', 'commit', 'diff', 'branch', '提交', '分支', '差异'].some(k => queryLc.includes(k))) {
    score += 4;
  }
  if (['web_search', 'read_url', 'fetch_page', 'http_get'].includes(name) &&
    [
      // explicit web/search intent
      'web', 'url', 'http', 'research', '搜索', '搜', '网页', '联网', '上网', '资料', '查询', '查一下', '查查',
      // time-sensitive / current-events intent — the reason "今日热点新闻" used to
      // miss web_search entirely (it scored 0 and never made the tool shortlist)
      'news', 'today', 'latest', 'current', 'recent', 'now', 'breaking', 'trending', 'weather', 'price', 'stock',
      '新闻', '今日', '今天', '最新', '近期', '实时', '热点', '热搜', '头条', '动态', '行情', '股价', '汇率', '天气', '比分', '发布',
      '2024', '2025', '2026',
    ].some(k => queryLc.includes(k))) {
    score += 5;
  }
  if (['list_skills', 'use_skill'].includes(name) &&
    ['skill', '能力', '技能', 'ppt', 'pdf', 'excel', 'xlsx', 'docx'].some(k => queryLc.includes(k))) {
    score += 4;
  }

  return score;
}

/**
 * Return up to ~topK tool names ordered by relevance to the query.
 *
 * Always-included infrastructure tools and mustInclude (e.g. active
 * skill required_tools) are appended regardless of score. When the candidate
 * set is already small (<= topK + |mustInclude|), no filtering is applied.
 *
 * A short or empty query means we have no signal to filter — returning the
 * full candidate set is correct in that case.
 */
export function selectRelevantTools(
  registry: ToolRegistry,
  candidateNames: string[],
  query: string,
  options?: {
    topK?: number;
    mustInclude?: Set<string>;
  }
): string[] {
  const topK = options?.topK ?? 12;
  const explicitMust = new Set(options?.mustInclude ?? []);

  const infraPresent = candidateNames.filter(n => INFRA_TOOLS.has(n) && !explicitMust.has(n));
  const mustPresent = candidateNames.filter(n => explicitMust.has(n));
  const remaining = candidateNames.filter(n => !explicitMust.has(n) && !INFRA_TOOLS.has(n));

  const queryTokens = tokenize(query);
  const queryLc = (query || '').toLowerCase();
  const smallSurface = candidateNames.length <= topK + mustPresent.length + infraPresent.length;
  const lowSignal = queryTokens.size < 2 && queryLc.length < 8;

  // No filtering when the set is already small or the query is too short
  if (smallSurface || lowSignal) {
    return [...mustPresent, ...infraPresent, ...remaining];
  }

  const scored: Array<{ name: string; score: number; penalty: number }> = [];
  const allScoredNames = [...infraPresent, ...remaining];

  for (const name of allScoredNames) {
    const tool = registry.get(name);
    if (!tool) continue;
    const score = scoreTool(tool, queryTokens, queryLc);
    const penalty = MUTATING_TOOLS.has(name) && score === 0 ? 1 : 0;
    scored.push({ name, score, penalty });
  }

  // Stable sort by descending score; zero-score tools only fill spare slots
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.penalty - b.penalty;
  });

  const budget = Math.max(0, topK - mustPresent.length);
  const picked: string[] = [];
  const pickedSet = new Set<string>();

  for (const item of scored) {
    if (picked.length >= budget) break;
    if (item.score > 0) {
      picked.push(item.name);
      pickedSet.add(item.name);
    }
  }

  // Fill remaining slots with zero-score tools
  if (picked.length < budget) {
    for (const item of scored) {
      if (picked.length >= budget) break;
      if (!pickedSet.has(item.name)) {
        picked.push(item.name);
        pickedSet.add(item.name);
      }
    }
  }

  return [...mustPresent, ...picked];
}
