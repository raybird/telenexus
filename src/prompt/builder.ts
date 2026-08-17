/**
 * Prompt 組裝與記憶體上下文建構
 */
import type { ChatPromptConfig } from '../config/ai-config.js';
import type { ChatMessage, MemoryManager, SummaryMessage } from '../core/memory.js';
import {
  collectSarTags,
  expandSarKeywords,
  scoreSarSummaryBase,
  SAR_PROMPT_POLICY
} from '../core/sar-policy.js';

export function shouldSummarize(content: string): boolean {
  if (content.length > 200) return true;
  if (content.includes('```') || content.includes('tool_result')) return true;
  if ((content.match(/\n/g) || []).length >= 6) return true;
  return false;
}

const QUERY_STOPWORDS = new Set([
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

function extractQueryKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !QUERY_STOPWORDS.has(item));

  const unique: string[] = [];
  for (const token of tokens) {
    if (!unique.includes(token)) {
      unique.push(token);
    }
    if (unique.length >= 8) break;
  }
  return unique;
}

function applyKeywordAliases(text: string, baseKeywords: string[]): string[] {
  return expandSarKeywords(text, baseKeywords);
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
  return collectSarTags(text);
}

function scoreSummary(
  summary: SummaryMessage,
  queryTags: string[] = [],
  keywords: string[] = []
): number {
  return scoreSarSummaryBase(summary, {
    tokens: keywords,
    tags: queryTags
  });
}

function isAnchorCandidate(summary: SummaryMessage): boolean {
  const text = `${summary.summary || ''} ${summary.content || ''}`.toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (SAR_PROMPT_POLICY.anchorExcludeHints.some((hint) => text.includes(hint))) {
    return false;
  }
  return SAR_PROMPT_POLICY.anchorHints.some((hint) => text.includes(hint));
}

function buildDedupKey(role: string, text: string, timestamp: number): string {
  return `${role}|${timestamp}|${text.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

function isCanonicalAnchor(
  summary: SummaryMessage,
  queryTags: string[],
  keywords: string[]
): boolean {
  if ((summary.impactLevel || 1) < 3) {
    return false;
  }

  const text = `${summary.summary || ''} ${summary.content || ''}`.toLowerCase();
  const tagMatched = queryTags.some((tag) => summary.tags.includes(tag));
  const keywordMatched = keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  return tagMatched || keywordMatched;
}

function mergeUniqueSummaries(...groups: SummaryMessage[][]): SummaryMessage[] {
  const merged: SummaryMessage[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const item of group) {
      const key = buildDedupKey(item.role, item.summary || item.content, item.timestamp);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function getAnchorCandidates(memory: MemoryManager, userId: string): SummaryMessage[] {
  const recentAnchors = memory.getRecentSummaries(
    userId,
    SAR_PROMPT_POLICY.anchorCandidateLimit,
    2
  );
  const canonicalAnchors = memory.listSummaryMessages(
    userId,
    SAR_PROMPT_POLICY.canonicalCandidateLimit,
    3
  );
  // 時間視窗 fallback：所有 impact_level=3 規則不因老化而遺失
  const allCanonicals = memory.getAllCanonicalSummaries(userId);
  const fallbackAnchors = recentAnchors.length > 0 ? [] : memory.getRecentSummaries(userId, 20, 1);
  return mergeUniqueSummaries(allCanonicals, canonicalAnchors, recentAnchors, fallbackAnchors);
}

function selectCausalAnchors(
  summaries: SummaryMessage[],
  queryTags: string[] = [],
  keywords: string[] = []
): SummaryMessage[] {
  const filtered = summaries.filter(isAnchorCandidate);
  const tagMatched = filtered.filter((item) => queryTags.some((tag) => item.tags.includes(tag)));
  const source = tagMatched.length > 0 ? tagMatched : filtered.length > 0 ? filtered : summaries;
  const ranked = [...source].sort((a, b) => {
    const scoreDiff = scoreSummary(b, queryTags, keywords) - scoreSummary(a, queryTags, keywords);
    if (scoreDiff !== 0) return scoreDiff;
    return b.timestamp - a.timestamp;
  });

  const canonical = ranked.filter((item) => isCanonicalAnchor(item, queryTags, keywords));
  const selected: SummaryMessage[] = [];
  const seen = new Set<string>();

  for (const item of canonical.slice(0, SAR_PROMPT_POLICY.canonicalLimit)) {
    const key = buildDedupKey(item.role, item.summary || item.content, item.timestamp);
    seen.add(key);
    selected.push(item);
  }

  for (const item of ranked) {
    const key = buildDedupKey(item.role, item.summary || item.content, item.timestamp);
    if (seen.has(key)) {
      continue;
    }
    selected.push(item);
    seen.add(key);
    if (selected.length >= SAR_PROMPT_POLICY.anchorLimit) {
      break;
    }
  }

  return selected;
}

function selectSemanticSummaries(
  memory: MemoryManager,
  userId: string,
  userMessage: string,
  recentSummaries: SummaryMessage[]
): SummaryMessage[] {
  const keywords = applyKeywordAliases(userMessage, extractQueryKeywords(userMessage));
  const queryTags = extractTopicTags(userMessage);
  const selected: SummaryMessage[] = [];
  const seen = new Set<string>();

  const pushUnique = (item: SummaryMessage): boolean => {
    const key = buildDedupKey(item.role, item.summary || item.content, item.timestamp);
    if (seen.has(key)) return false;
    seen.add(key);
    selected.push(item);
    return selected.length >= SAR_PROMPT_POLICY.semanticLimit;
  };

  const localMatches = recentSummaries
    .map((item) => {
      return {
        item,
        score: scoreSarSummaryBase(item, {
          text: userMessage,
          tokens: keywords,
          tags: queryTags
        })
      };
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
    let matches = memory.searchSummaries(userId, keyword, SAR_PROMPT_POLICY.semanticLimit, 2);
    if (matches.length === 0) {
      matches = memory.searchSummaries(userId, keyword, SAR_PROMPT_POLICY.semanticLimit, 1);
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
    return `- [${role}] (${formatTimestampInline(item.timestamp)}) ${truncateInline(item.content, SAR_PROMPT_POLICY.recentItemCharBudget)}`;
  });
}

function formatSummaryItems(items: SummaryMessage[]): string[] {
  return items.map((item) => {
    const text = item.summary || item.content;
    return `- [${formatTimestampInline(item.timestamp)}] ${truncateInline(text, SAR_PROMPT_POLICY.summaryItemCharBudget)}`;
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

  const getMinLines = (title: string): number => {
    if (title === '【核心決策回顧】') {
      return SAR_PROMPT_POLICY.anchorMinLines;
    }
    if (title === '【相關歷史摘要】') {
      return SAR_PROMPT_POLICY.semanticMinLines;
    }
    if (title === '【近期對話】') {
      return SAR_PROMPT_POLICY.recentMinLines;
    }
    return 0;
  };

  const trimSectionToMinimum = (sectionTitle: string): boolean => {
    const section = mutableSections.find((item) => item.title === sectionTitle);
    const minLines = getMinLines(sectionTitle);
    if (!section || section.lines.length <= minLines) {
      return false;
    }
    section.lines.pop();
    return true;
  };

  const compactLine = (line: string, maxLength: number): string => {
    if (line.length <= maxLength) {
      return line;
    }

    const match = line.match(/^(-\s+\[[^\]]+\](?:\s+\([^\)]+\))?\s+)(.+)$/);
    if (!match) {
      return truncateInline(line, maxLength);
    }

    const prefix = match[1] || '';
    const text = match[2] || line;
    const available = Math.max(12, maxLength - prefix.length);
    return prefix + truncateInline(text, available);
  };

  const compactSections = (lineBudget: number): void => {
    for (const section of mutableSections) {
      section.lines = section.lines.map((line) => compactLine(line, lineBudget));
    }
  };

  const trimOrder = ['【相關歷史摘要】', '【近期對話】', '【核心決策回顧】'];
  for (const sectionTitle of trimOrder) {
    while (trimSectionToMinimum(sectionTitle)) {
      result = renderSections(mutableSections);
      if (result.length <= budget) {
        return result;
      }
    }
  }

  result = renderSections(mutableSections);

  if (result.length <= budget) {
    return result;
  }

  compactSections(140);
  result = renderSections(mutableSections);
  if (result.length <= budget) {
    return result;
  }

  compactSections(110);
  result = renderSections(mutableSections);
  if (result.length <= budget) {
    return result;
  }

  return truncateInline(result, budget);
}

function buildSarContext(memory: MemoryManager, userId: string, userMessage: string): string {
  const keywords = applyKeywordAliases(userMessage, extractQueryKeywords(userMessage));
  const queryTags = extractTopicTags(userMessage);
  const recent = memory.getRecentConversation(userId, SAR_PROMPT_POLICY.recentLimit);
  const anchorCandidates = getAnchorCandidates(memory, userId);
  const anchors = selectCausalAnchors(anchorCandidates, queryTags, keywords);
  const semanticCandidates = selectSemanticSummaries(memory, userId, userMessage, anchorCandidates);

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
        lines: formatSummaryItems(semantics.slice(0, SAR_PROMPT_POLICY.semanticLimit))
      },
      { title: '【近期對話】', lines: formatRecentMessages(recent) }
    ],
    Math.max(
      200,
      SAR_PROMPT_POLICY.totalCharBudget - `${SAR_PROMPT_POLICY.memoryContextTitle}\n`.length
    )
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
  return [SAR_PROMPT_POLICY.memoryContextTitle, context].join('\n');
}

export type MemoriaRecallFn = (query: string, scope?: string) => Promise<string[]>;

export async function buildMemoryContextAsync(
  memory: MemoryManager,
  userId: string,
  userMessage: string,
  recallFn?: MemoriaRecallFn | null
): Promise<string> {
  if (!recallFn) {
    return buildMemoryContext(memory, userId, userMessage);
  }

  const keywords = applyKeywordAliases(userMessage, extractQueryKeywords(userMessage));
  const queryTags = extractTopicTags(userMessage);
  const recent = memory.getRecentConversation(userId, SAR_PROMPT_POLICY.recentLimit);
  const anchorCandidates = getAnchorCandidates(memory, userId);
  const anchors = selectCausalAnchors(anchorCandidates, queryTags, keywords);

  // 原句直接送 Memoria。
  //
  // v2.23.0–v2.25.x 這裡曾在呼叫端把中文切成重疊 2-gram,因為當時的 Memoria 把一整句 CJK
  // 當單一 token、要求逐字命中。Memoria v1.28.0 把 CJK 切詞做進去了,而且 n 由呼叫端的
  // minLength 決定(FTS 用 3 對上 trigram 索引 / tokenCoverage 與 tree 用 2)—— 它能各給各半邊
  // 正確的窗格,我們在外面切做不到那件事。
  //
  // 實測(正式環境快照 957 筆、scope user: 的 15 筆、8 題措辭不同的中文問句,凍結後才跑):
  //   1.27.1 + 原句     0/8 命中,回傳 0 筆,basis=no_hits   ← 我們當初做那層的理由
  //   1.27.1 + 我們切詞  8/8 命中,31 筆,精確度 0.323
  //   1.28.0 + 原句     8/8 命中,32 筆,精確度 0.313
  //   1.28.0 + 我們切詞  8/8 命中,31 筆,精確度 0.323
  // 1.28.0 上兩者**逐題命中的 session 完全相同**,所以那層在 1.28.0 是 no-op,移除不損失召回。
  //
  // ⚠️ 這一行與 docker/memoria.Dockerfile 的釘選是綁在一起的:降版回 1.27.x 而不還原切詞層,
  // 中文召回會直接回到 0/8(上表第一列)。
  let semanticLines: string[];
  try {
    const snippets = await recallFn(userMessage, `user:${userId}`);
    if (snippets.length > 0) {
      semanticLines = snippets
        .slice(0, SAR_PROMPT_POLICY.semanticLimit)
        .map((s) => `- ${truncateInline(s, SAR_PROMPT_POLICY.summaryItemCharBudget)}`);
    } else {
      semanticLines = buildLocalSemanticLines(memory, userId, userMessage, anchorCandidates, anchors);
    }
  } catch {
    semanticLines = buildLocalSemanticLines(memory, userId, userMessage, anchorCandidates, anchors);
  }

  const context = applyContextBudget(
    [
      { title: '【核心決策回顧】', lines: formatSummaryItems(anchors) },
      { title: '【相關歷史摘要】', lines: semanticLines },
      { title: '【近期對話】', lines: formatRecentMessages(recent) }
    ],
    Math.max(200, SAR_PROMPT_POLICY.totalCharBudget - `${SAR_PROMPT_POLICY.memoryContextTitle}\n`.length)
  );

  if (!context.trim()) return '';
  return [SAR_PROMPT_POLICY.memoryContextTitle, context].join('\n');
}

function buildLocalSemanticLines(
  memory: MemoryManager,
  userId: string,
  userMessage: string,
  anchorCandidates: SummaryMessage[],
  anchors: SummaryMessage[]
): string[] {
  const anchorKeys = new Set(
    anchors.map((item) => buildDedupKey(item.role, item.summary || item.content, item.timestamp))
  );
  const semanticCandidates = selectSemanticSummaries(memory, userId, userMessage, anchorCandidates);
  const semantics = semanticCandidates.filter(
    (item) =>
      !anchorKeys.has(buildDedupKey(item.role, item.summary || item.content, item.timestamp))
  );
  return formatSummaryItems(semantics.slice(0, SAR_PROMPT_POLICY.semanticLimit));
}

export function buildChatPrompt(
  config: ChatPromptConfig,
  userMessage: string,
  memoryContext = '',
  mode: 'full' | 'compact' | 'minimal' = 'full',
  capabilityHint = '',
  systemSummary = '',
  skillsHint = ''
): string {
  const sections: string[] = [];

  const isMinimal = mode === 'minimal';
  const isCompact = mode === 'compact';

  if (isMinimal) {
    sections.push(
      `延續目前對話 Session 與最近一次系統規則。請用${config.language}回應，除非使用者明確要求，否則不要重複前文。`
    );
    sections.push(`User Message:\n${userMessage}`);

    if (config.includeAiResponseSuffix) {
      sections.push('AI Response:');
    }

    return sections.join('\n\n').trim();
  }

  sections.push('System: ' + config.roleSystem);

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

  if (!isCompact && systemSummary.trim().length > 0) {
    sections.push(`【系統狀態】\n${systemSummary.trim()}`);
  }

  if (!isCompact && skillsHint.trim().length > 0) {
    sections.push(`【可用技能索引】\n${skillsHint.trim()}`);
  }

  if (capabilityHint.trim().length > 0) {
    sections.push(`【可用能力提示】\n${capabilityHint.trim()}`);
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
