/**
 * Prompt 組裝與記憶體上下文建構
 */
import type { ChatPromptConfig } from '../config/ai-config.js';
import type { ChatMessage, MemoryManager, SummaryMessage } from '../core/memory.js';

const SAR_RECENT_LIMIT = 10;
const SAR_ANCHOR_LIMIT = 4;
const SAR_SEMANTIC_LIMIT = 3;
const SAR_TOTAL_CHAR_BUDGET = 1500;
const SAR_RECENT_ITEM_CHAR_BUDGET = 180;
const SAR_SUMMARY_ITEM_CHAR_BUDGET = 220;
const SAR_ANCHOR_HINTS = [
  'decision',
  '決策',
  'fix',
  '修復',
  'release',
  'deploy',
  'workflow',
  'sop',
  'docker',
  'git',
  'runner',
  'gemini',
  'scheduler',
  'memory',
  'prompt',
  'compress',
  'fallback',
  'chat',
  'web'
];
const SAR_ANCHOR_EXCLUDE_HINTS = ['btc', 'crypto market pulse', 'sso', '市場脈動'];
const SAR_TOPIC_TAG_MAP: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'release', patterns: [/release/i, /發版/, /發布/, /tag/i, /npm version/i, /sop/i] },
  {
    tag: 'web',
    patterns: [/web/i, /chat history/i, /sidebar/i, /nav/i, /ux/i, /前端/, /上滑/, /滾動/]
  },
  { tag: 'scheduler', patterns: [/scheduler/i, /cron/i, /排程/] },
  { tag: 'gemini', patterns: [/gemini/i, /compress/i, /invalid_argument/i, /resource_exhausted/i] },
  { tag: 'runner', patterns: [/runner/i, /agent-runner/i] },
  { tag: 'memory', patterns: [/memory/i, /sar/i, /summary-aware retrieval/i, /記憶/, /摘要/] },
  { tag: 'infra', patterns: [/docker/i, /bootstrap/i, /git/i, /部署/, /infra/i] }
];

export function shouldSummarize(content: string): boolean {
  if (content.length > 200) return true;
  if (content.includes('```') || content.includes('tool_result')) return true;
  if ((content.match(/\n/g) || []).length >= 6) return true;
  return false;
}

function extractQueryKeywords(text: string): string[] {
  const stopwords = new Set([
    '請',
    '幫我',
    '一下',
    '這個',
    '那個',
    '今天',
    '現在',
    '可以',
    '是否',
    '如何',
    '什麼',
    '哪裡',
    'then',
    'that',
    'this',
    'with',
    'from',
    'what',
    'when',
    'where',
    'which',
    'would',
    'should',
    'could',
    'please',
    'help'
  ]);

  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !stopwords.has(item));

  const unique: string[] = [];
  for (const token of tokens) {
    if (!unique.includes(token)) {
      unique.push(token);
    }
    if (unique.length >= 8) break;
  }
  return unique;
}

function truncateInline(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength - 1) + '…';
}

function formatTimestampInline(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
}

function extractTopicTags(userMessage: string): string[] {
  const text = userMessage.trim();
  if (!text) {
    return [];
  }
  const matches: string[] = [];
  for (const entry of SAR_TOPIC_TAG_MAP) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      matches.push(entry.tag);
    }
  }
  return matches;
}

function scoreSummary(
  summary: SummaryMessage,
  queryTags: string[] = [],
  keywords: string[] = []
): number {
  const text = `${summary.summary || ''} ${summary.content || ''}`.trim();
  const lowered = text.toLowerCase();
  let score = 0;
  score += Math.min(3, Math.floor(text.length / 140));
  score += Math.max(0, (summary.impactLevel || 1) - 1) * 3;
  if (/[Dd]ecision|決策|SOP|流程|規則|限制|fallback|bootstrap|runner|Gemini/.test(text)) {
    score += 2;
  }
  if (
    summary.tags.includes('release') ||
    summary.tags.includes('gemini') ||
    summary.tags.includes('runner')
  ) {
    score += 2;
  }
  if (summary.role === 'model') {
    score += 1;
  }
  for (const tag of queryTags) {
    if (summary.tags.includes(tag)) {
      score += 5;
    }
  }
  for (const keyword of keywords) {
    if (lowered.includes(keyword.toLowerCase())) {
      score += 2;
    }
  }
  return score;
}

function isAnchorCandidate(summary: SummaryMessage): boolean {
  const text = `${summary.summary || ''} ${summary.content || ''}`.toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (SAR_ANCHOR_EXCLUDE_HINTS.some((hint) => text.includes(hint))) {
    return false;
  }
  return SAR_ANCHOR_HINTS.some((hint) => text.includes(hint));
}

function buildDedupKey(role: string, text: string, timestamp: number): string {
  return `${role}|${timestamp}|${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function selectCausalAnchors(
  summaries: SummaryMessage[],
  queryTags: string[] = [],
  keywords: string[] = []
): SummaryMessage[] {
  const filtered = summaries.filter(isAnchorCandidate);
  const tagMatched = filtered.filter((item) => queryTags.some((tag) => item.tags.includes(tag)));
  const source = tagMatched.length > 0 ? tagMatched : filtered.length > 0 ? filtered : summaries;
  return [...source]
    .sort((a, b) => {
      const scoreDiff = scoreSummary(b, queryTags, keywords) - scoreSummary(a, queryTags, keywords);
      if (scoreDiff !== 0) return scoreDiff;
      return b.timestamp - a.timestamp;
    })
    .slice(0, SAR_ANCHOR_LIMIT);
}

function selectSemanticSummaries(
  memory: MemoryManager,
  userId: string,
  userMessage: string,
  recentSummaries: SummaryMessage[]
): SummaryMessage[] {
  const keywords = extractQueryKeywords(userMessage);
  const queryTags = extractTopicTags(userMessage);
  const selected: SummaryMessage[] = [];
  const seen = new Set<string>();

  const pushUnique = (item: SummaryMessage): boolean => {
    const key = buildDedupKey(item.role, item.summary || item.content, item.timestamp);
    if (seen.has(key)) return false;
    seen.add(key);
    selected.push(item);
    return selected.length >= SAR_SEMANTIC_LIMIT;
  };

  const localMatches = recentSummaries
    .map((item) => {
      const haystack = `${item.summary || ''} ${item.content || ''}`.toLowerCase();
      let score = 0;
      for (const keyword of keywords) {
        if (haystack.includes(keyword.toLowerCase())) {
          score += 2;
        }
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const tagBoost =
        queryTags.filter((tag) => b.item.tags.includes(tag)).length -
        queryTags.filter((tag) => a.item.tags.includes(tag)).length;
      if (tagBoost !== 0) return tagBoost;
      if (b.score !== a.score) return b.score - a.score;
      return b.item.timestamp - a.item.timestamp;
    });

  for (const entry of localMatches) {
    if (pushUnique(entry.item)) {
      return selected;
    }
  }

  for (const keyword of keywords) {
    let matches = memory.searchSummaries(userId, keyword, SAR_SEMANTIC_LIMIT, 2);
    if (matches.length === 0) {
      matches = memory.searchSummaries(userId, keyword, SAR_SEMANTIC_LIMIT, 1);
    }
    for (const item of matches) {
      if (pushUnique(item)) {
        return selected;
      }
    }
  }

  return selected;
}

function formatRecentMessages(items: ChatMessage[]): string[] {
  return items.map((item) => {
    const role = item.role === 'user' ? 'User' : 'AI';
    return `- [${role}] (${formatTimestampInline(item.timestamp)}) ${truncateInline(item.content, SAR_RECENT_ITEM_CHAR_BUDGET)}`;
  });
}

function formatSummaryItems(items: SummaryMessage[]): string[] {
  return items.map((item) => {
    const text = item.summary || item.content;
    return `- [${formatTimestampInline(item.timestamp)}] ${truncateInline(text, SAR_SUMMARY_ITEM_CHAR_BUDGET)}`;
  });
}

function applyContextBudget(
  sections: Array<{ title: string; lines: string[] }>,
  budget: number
): string {
  const renderSections = (items: Array<{ title: string; lines: string[] }>): string =>
    items
      .filter((section) => section.lines.length > 0)
      .map((section) => [section.title, ...section.lines].join('\n'))
      .join('\n\n');

  const activeSections = sections.filter((section) => section.lines.length > 0);
  if (activeSections.length === 0) {
    return '';
  }

  let result = renderSections(activeSections);

  if (result.length <= budget) {
    return result;
  }

  const mutableSections = activeSections.map((section) => ({
    title: section.title,
    lines: [...section.lines]
  }));

  const trimOrder = ['【相關歷史摘要】', '【近期對話】', '【核心決策回顧】'];
  for (const sectionTitle of trimOrder) {
    const section = mutableSections.find((item) => item.title === sectionTitle);
    while (section && section.lines.length > 0) {
      result = renderSections(mutableSections);
      if (result.length <= budget) {
        return result;
      }
      section.lines.pop();
    }
  }

  result = renderSections(mutableSections);

  return result.length <= budget ? result : truncateInline(result, budget);
}

function buildSarContext(memory: MemoryManager, userId: string, userMessage: string): string {
  const keywords = extractQueryKeywords(userMessage);
  const queryTags = extractTopicTags(userMessage);
  const recent = memory.getRecentConversation(userId, SAR_RECENT_LIMIT);
  const anchorCandidates = memory.getRecentSummaries(userId, 12, 2);
  const fallbackAnchorCandidates =
    anchorCandidates.length > 0 ? anchorCandidates : memory.getRecentSummaries(userId, 12, 1);
  const anchors = selectCausalAnchors(fallbackAnchorCandidates, queryTags, keywords);
  const semanticCandidates = selectSemanticSummaries(
    memory,
    userId,
    userMessage,
    fallbackAnchorCandidates
  );

  const anchorKeys = new Set(
    anchors.map((item) => buildDedupKey(item.role, item.summary || item.content, item.timestamp))
  );
  const semantics = semanticCandidates.filter(
    (item) =>
      !anchorKeys.has(buildDedupKey(item.role, item.summary || item.content, item.timestamp))
  );

  return applyContextBudget(
    [
      { title: '【核心決策回顧】', lines: formatSummaryItems(anchors) },
      {
        title: '【相關歷史摘要】',
        lines: formatSummaryItems(semantics.slice(0, SAR_SEMANTIC_LIMIT))
      },
      { title: '【近期對話】', lines: formatRecentMessages(recent) }
    ],
    SAR_TOTAL_CHAR_BUDGET
  );
}

export function buildMemoryContext(
  memory: MemoryManager,
  userId: string,
  userMessage: string
): string {
  const context = buildSarContext(memory, userId, userMessage);
  if (!context.trim()) {
    return '';
  }
  return ['【記憶參考（TeleNexus SAR）】', context].join('\n');
}

export function buildChatPrompt(
  config: ChatPromptConfig,
  userMessage: string,
  memoryContext = '',
  mode: 'full' | 'compact' = 'full'
): string {
  const sections: string[] = [];

  sections.push('System: ' + config.roleSystem);

  const isCompact = mode === 'compact';

  if (isCompact) {
    sections.push(
      '延續目前對話 Session 的既有規則（語言、工具使用、工作目錄與檔案回傳協議）。若有衝突，以最近一次系統規則為準。'
    );
  }

  if (!isCompact && config.yoloNoticeEnabled) {
    sections.push('現在已經開啟了 YOLO 模式，你的所有工具調用都會被自動允許。');
  }

  sections.push(`請用${config.language}回應。`);

  if (!isCompact && config.memoryPolicyEnabled) {
    const lines = config.memoryPolicyLines.map((line) => `- ${line}`).join('\n');
    sections.push(`【知識管理 - 重要】\n你有 MCP Memory 工具可以儲存長期知識與關係：\n${lines}`);
  }

  if (!isCompact && config.workspacePolicyEnabled) {
    const lines = config.workspacePolicyLines.map((line) => `- ${line}`).join('\n');
    sections.push(`【工作目錄限制 - 重要】\n${lines}`);
  }

  if (!isCompact) {
    sections.push(
      '【檔案回傳協議】\n若使用者要求你把檔案直接傳到 Telegram，請先將檔案輸出到 workspace/temp/，再在回覆中加入標記：[[SEND_FILE: workspace/temp/檔名 | 可選說明]]。\n可同時放多個標記，系統會依序送出檔案。'
    );
  }

  if (memoryContext.trim().length > 0) {
    sections.push(
      '【SAR 使用規則】\n若出現「核心決策回顧」或「相關歷史摘要」，請將其視為長期記憶約束與背景依據，而不是普通聊天雜訊。\n若與近期對話衝突，優先採用較新的明確決策；若不衝突，請延續這些決策與規則作答。'
    );
    sections.push(memoryContext.trim());
  }

  sections.push(`User Message:\n${userMessage}`);

  if (config.includeAiResponseSuffix) {
    sections.push('AI Response:');
  }

  return sections.join('\n\n').trim();
}
