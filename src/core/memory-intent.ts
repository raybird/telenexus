/**
 * 前三個是「值得保留的程度」階梯,後三個是「保留成什麼」的種類。
 * rule / decision / skill 會被寫成 Memoria 的 DecisionMade / SkillLearned 事件
 * (見 memoria-sync.ts buildMemoryEvent) —— 那是 Memoria 關鍵字召回語料的唯二事件型別。
 */
export type MemoryIntentLevel =
  | 'none'
  | 'short-term'
  | 'long-term-candidate'
  | 'rule'
  | 'decision'
  | 'skill';

export type MemoryIntentConfidence = 'low' | 'medium' | 'high';

export type MemoryIntent = {
  level: MemoryIntentLevel;
  confidence: MemoryIntentConfidence;
  reason: string;
  summary?: string;
};

export type ParsedMemoryIntent = {
  cleanedResponse: string;
  intent: MemoryIntent | null;
};

const INTENT_BLOCK_REGEX = /\n?\s*\[\[MEMORY_INTENT:\s*(\{[\s\S]*?\})\s*\]\]\s*$/;

function isValidLevel(value: unknown): value is MemoryIntentLevel {
  return (
    value === 'none' ||
    value === 'short-term' ||
    value === 'long-term-candidate' ||
    value === 'rule' ||
    value === 'decision' ||
    value === 'skill'
  );
}

function isValidConfidence(value: unknown): value is MemoryIntentConfidence {
  return value === 'low' || value === 'medium' || value === 'high';
}

function normalizeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

export function parseMemoryIntent(response: string): ParsedMemoryIntent {
  const match = response.match(INTENT_BLOCK_REGEX);
  if (!match) {
    return { cleanedResponse: response, intent: null };
  }

  const jsonText = (match[1] || '').trim();
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const level = parsed.level;
    const confidence = parsed.confidence;
    const reason = normalizeString(parsed.reason, 280);
    const summary = normalizeString(parsed.summary, 280);

    if (!isValidLevel(level) || !isValidConfidence(confidence) || !reason) {
      return { cleanedResponse: response, intent: null };
    }

    const cleanedResponse = response.replace(INTENT_BLOCK_REGEX, '').trimEnd();
    return {
      cleanedResponse,
      intent: {
        level,
        confidence,
        reason,
        ...(summary ? { summary } : {})
      }
    };
  } catch {
    return { cleanedResponse: response, intent: null };
  }
}
