export const SAR_TAG_RULES: Array<{ tag: string; patterns: RegExp[] }> = [
  { tag: 'release', patterns: [/release/i, /發版/, /發布/, /tag/i, /npm version/i, /sop/i] },
  {
    tag: 'web',
    patterns: [
      /web/i,
      /chat history/i,
      /sidebar/i,
      /nav/i,
      /ux/i,
      /frontend/i,
      /前端/,
      /上滑/,
      /滾動/
    ]
  },
  { tag: 'scheduler', patterns: [/scheduler/i, /cron/i, /排程/] },
  { tag: 'opencode', patterns: [/opencode/i, /compress/i, /compact/i, /invalid_argument/i, /resource_exhausted/i] },
  { tag: 'runner', patterns: [/runner/i, /agent-runner/i] },
  { tag: 'memory', patterns: [/memory/i, /summary-aware retrieval/i, /sar/i, /記憶/, /摘要/] },
  { tag: 'infra', patterns: [/docker/i, /bootstrap/i, /git/i, /git identity/i, /部署/, /infra/i] }
];

export const SAR_QUERY_ALIAS_RULES: Array<{
  patterns: RegExp[];
  keywords: string[];
  tags?: string[];
}> = [
  {
    patterns: [/發版/, /發布/, /release workflow/i, /release sop/i, /發版流程/],
    keywords: ['release', 'workflow', 'npm version', 'tag', 'push'],
    tags: ['release']
  },
  {
    patterns: [/壓縮/, /compress/i, /invalid_argument/i, /resource_exhausted/i, /容量不足/],
    keywords: ['compress', 'invalid_argument', 'resource_exhausted', 'model_capacity_exhausted'],
    tags: ['opencode', 'runner']
  },
  {
    patterns: [/上滑載入/, /聊天往上滾/, /chat history/i, /cursor/i, /prepend/i, /閃爍/],
    keywords: ['chat history', 'cursor', 'incremental prepend', 'offset pagination'],
    tags: ['web']
  },
  {
    patterns: [/scheduler cli/i, /排程 cli/, /reload/i, /update schedule/i],
    keywords: ['scheduler-cli', 'reload', 'update', 'cli tool'],
    tags: ['scheduler']
  }
];

export const SAR_METADATA_IMPACT_PATTERNS = {
  level3: /sop|營運憲法|技術地板|bootstrap|fallback|compress|resource_exhausted|invalid_argument/i,
  level2:
    /decision|決策|fix|修復|release|deploy|workflow|scheduler|runner|opencode|chat history|cursor/i
} as const;

export const SAR_SUMMARY_SEARCH_CONFIG = {
  tokenLimit: 8,
  candidateMultiplier: 4,
  minCandidatePool: 12,
  scoring: {
    exactSummaryMatch: 10,
    exactContentMatch: 4,
    tokenSummaryMatch: 4,
    tokenContentMatch: 1,
    tokenTagMatch: 5,
    impactLevelBonus: 2,
    recentWindowDays: 7,
    recentBonus: 2,
    warmWindowDays: 30,
    warmBonus: 1
  }
} as const;

export type SarSummaryScoreInput = {
  summary: string;
  content: string;
  tags: string[];
  impactLevel: number;
  timestamp: number;
  role: 'user' | 'model';
};

export type SarSummaryScoreQuery = {
  text?: string;
  tokens?: string[];
  tags?: string[];
};

export const SAR_PROMPT_POLICY = {
  recentLimit: 10,
  anchorLimit: 4,
  semanticLimit: 3,
  totalCharBudget: 1500,
  recentItemCharBudget: 180,
  summaryItemCharBudget: 220,
  recentMinLines: 4,
  anchorMinLines: 1,
  semanticMinLines: 1,
  memoryContextTitle: '【記憶參考（TeleNexus SAR）】',
  canonicalLimit: 1,
  anchorCandidateLimit: 40,
  canonicalCandidateLimit: 100,
  anchorHints: [
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
    'opencode',
    'scheduler',
    'memory',
    'prompt',
    'compress',
    'fallback',
    'chat',
    'web'
  ],
  anchorExcludeHints: ['btc', 'crypto market pulse', 'sso', '市場脈動'],
  summaryRecencyBoosts: [
    { days: 7, score: 8 },
    { days: 14, score: 5 },
    { days: 30, score: 3 },
    { days: 90, score: 1 }
  ],
  summaryLengthDivisor: 140,
  summaryLengthMaxBonus: 3,
  summaryImpactBonus: 3,
  summaryImportantTextPattern:
    /[Dd]ecision|決策|SOP|流程|規則|限制|fallback|bootstrap|runner|Opencode/,
  summaryImportantTags: ['release', 'opencode', 'runner'],
  summaryImportantTagBonus: 2,
  summaryImportantTextBonus: 2,
  summaryModelRoleBonus: 1,
  summaryQueryTagBonus: 5,
  summaryKeywordBonus: 2
} as const;

export function collectSarTags(text: string): string[] {
  const matches: string[] = [];

  for (const entry of SAR_TAG_RULES) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      matches.push(entry.tag);
    }
  }

  for (const alias of SAR_QUERY_ALIAS_RULES) {
    if (!alias.tags || !alias.patterns.some((pattern) => pattern.test(text))) {
      continue;
    }
    for (const tag of alias.tags) {
      if (!matches.includes(tag)) {
        matches.push(tag);
      }
    }
  }

  return matches;
}

export function expandSarKeywords(text: string, baseKeywords: string[]): string[] {
  const expanded = [...baseKeywords];

  for (const alias of SAR_QUERY_ALIAS_RULES) {
    if (!alias.patterns.some((pattern) => pattern.test(text))) {
      continue;
    }
    for (const keyword of alias.keywords) {
      if (!expanded.includes(keyword)) {
        expanded.push(keyword);
      }
    }
  }

  return expanded.slice(0, 16);
}

export function getSarPromptRecencyBoost(timestamp: number): number {
  const ageMs = Math.max(0, Date.now() - timestamp);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  for (const rule of SAR_PROMPT_POLICY.summaryRecencyBoosts) {
    if (ageDays <= rule.days) {
      return rule.score;
    }
  }

  return 0;
}

export function scoreSarSummaryBase(
  item: SarSummaryScoreInput,
  query: SarSummaryScoreQuery = {}
): number {
  const summaryText = item.summary || '';
  const contentText = item.content || '';
  const combinedText = `${summaryText} ${contentText}`.trim();
  const loweredSummary = summaryText.toLowerCase();
  const loweredContent = contentText.toLowerCase();
  const loweredCombined = combinedText.toLowerCase();
  const loweredQuery = query.text?.trim().toLowerCase() || '';
  const tokens = Array.from(new Set((query.tokens || []).map((token) => token.toLowerCase())));
  const queryTags = Array.from(new Set((query.tags || []).map((tag) => tag.toLowerCase())));
  const normalizedTags = new Set(item.tags.map((tag) => tag.toLowerCase()));
  const scoring = SAR_SUMMARY_SEARCH_CONFIG.scoring;

  let score = 0;

  score += Math.min(
    SAR_PROMPT_POLICY.summaryLengthMaxBonus,
    Math.floor(combinedText.length / SAR_PROMPT_POLICY.summaryLengthDivisor)
  );
  score += Math.max(0, (item.impactLevel || 1) - 1) * SAR_PROMPT_POLICY.summaryImpactBonus;
  score += getSarPromptRecencyBoost(item.timestamp);

  if (SAR_PROMPT_POLICY.summaryImportantTextPattern.test(combinedText)) {
    score += SAR_PROMPT_POLICY.summaryImportantTextBonus;
  }
  if (SAR_PROMPT_POLICY.summaryImportantTags.some((tag) => normalizedTags.has(tag))) {
    score += SAR_PROMPT_POLICY.summaryImportantTagBonus;
  }
  if (item.role === 'model') {
    score += SAR_PROMPT_POLICY.summaryModelRoleBonus;
  }

  for (const tag of queryTags) {
    if (normalizedTags.has(tag)) {
      score += SAR_PROMPT_POLICY.summaryQueryTagBonus;
    }
  }

  if (loweredQuery) {
    if (loweredSummary.includes(loweredQuery)) {
      score += scoring.exactSummaryMatch;
    }
    if (loweredContent.includes(loweredQuery)) {
      score += scoring.exactContentMatch;
    }
  }

  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if (loweredSummary.includes(token)) {
      score += scoring.tokenSummaryMatch;
    }
    if (loweredContent.includes(token)) {
      score += scoring.tokenContentMatch;
    }
    if (normalizedTags.has(token)) {
      score += scoring.tokenTagMatch;
    }
    if (loweredCombined.includes(token)) {
      score += SAR_PROMPT_POLICY.summaryKeywordBonus;
    }
  }

  return score;
}
