import type { MessageMetadata } from './memory.js';
import { collectSarTags, SAR_METADATA_IMPACT_PATTERNS } from './sar-policy.js';

export function inferSummaryMetadata(content: string, summary?: string): MessageMetadata {
  const text = `${summary || ''}\n${content}`;
  let impactLevel = 1;

  if (SAR_METADATA_IMPACT_PATTERNS.level3.test(text)) {
    impactLevel = 3;
  } else if (SAR_METADATA_IMPACT_PATTERNS.level2.test(text)) {
    impactLevel = 2;
  }

  return {
    ...(summary ? { summary } : {}),
    impactLevel,
    tags: collectSarTags(text)
  };
}
