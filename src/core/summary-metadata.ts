import type { MessageMetadata } from './memory.js';

const SUMMARY_TAG_PATTERNS: Array<{ tag: string; patterns: RegExp[] }> = [
  {
    tag: 'release',
    patterns: [/release/, /npm version/, /git push/, /tag/, /發版/, /發布/, /sop/]
  },
  { tag: 'web', patterns: [/web/, /chat history/, /sidebar/, /nav/, /ux/, /frontend/, /前端/] },
  { tag: 'scheduler', patterns: [/scheduler/, /cron/, /排程/] },
  { tag: 'gemini', patterns: [/gemini/, /compress/, /invalid_argument/, /resource_exhausted/] },
  { tag: 'runner', patterns: [/runner/, /agent-runner/] },
  { tag: 'memory', patterns: [/memory/, /summary-aware retrieval/, /sar/, /記憶/, /摘要/] },
  { tag: 'infra', patterns: [/docker/, /bootstrap/, /git identity/, /部署/, /infra/] }
];

const IMPACT_LEVEL_3_PATTERN =
  /sop|營運憲法|技術地板|bootstrap|fallback|compress|resource_exhausted|invalid_argument/;
const IMPACT_LEVEL_2_PATTERN =
  /decision|決策|fix|修復|release|deploy|workflow|scheduler|runner|gemini|chat history|cursor/;

export function inferSummaryMetadata(content: string, summary?: string): MessageMetadata {
  const text = `${summary || ''}\n${content}`.toLowerCase();
  const tags = new Set<string>();
  let impactLevel = 1;

  for (const entry of SUMMARY_TAG_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      tags.add(entry.tag);
    }
  }

  if (IMPACT_LEVEL_3_PATTERN.test(text)) {
    impactLevel = 3;
  } else if (IMPACT_LEVEL_2_PATTERN.test(text)) {
    impactLevel = 2;
  }

  return {
    ...(summary ? { summary } : {}),
    impactLevel,
    tags: Array.from(tags)
  };
}
