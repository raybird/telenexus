import type { AgentEvent } from './agent-result.js';

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

const INTENT_MARKER_START = '[[MEMORY_INTENT:';
const INTENT_MARKER_END = ']]';

type IntentBlock = { start: number; end: number; fields: Record<string, unknown> | null };

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

/** 回傳 text 結尾有幾個字元可能是標記開頭,這些字元要等下一個 chunk 才知道能不能顯示。 */
function heldBackLength(text: string): number {
  for (let length = Math.min(INTENT_MARKER_START.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(INTENT_MARKER_START.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * 串流片段的標記過濾:標記可能被切到不同 chunk,所以疑似開頭的結尾字元會先留著。
 * 看到完整開頭後預覽就停在這裡,後面的正文由 done 事件與最終回覆補上。
 */
export function createMemoryIntentStreamFilter(): (chunk: string) => string {
  let held = '';
  let markerSeen = false;

  return (chunk) => {
    if (markerSeen) {
      return '';
    }
    const text = held + chunk;
    const markerStart = text.indexOf(INTENT_MARKER_START);
    if (markerStart !== -1) {
      markerSeen = true;
      held = '';
      return text.slice(0, markerStart);
    }
    const visibleLength = text.length - heldBackLength(text);
    held = text.slice(visibleLength);
    return text.slice(0, visibleLength);
  };
}

/**
 * 把 agent 事件轉成可以顯示的版本;回傳 null 代表這個事件沒有可顯示的內容。
 * `start` 代表重新開始一次執行(session-missing 重跑、runner 退回本機),過濾狀態要跟著重設。
 */
export function createVisibleEventFilter(): (event: AgentEvent) => AgentEvent | null {
  let visibleDelta = createMemoryIntentStreamFilter();
  let visibleReasoning = createMemoryIntentStreamFilter();

  return (event) => {
    switch (event.type) {
      case 'start':
        visibleDelta = createMemoryIntentStreamFilter();
        visibleReasoning = createMemoryIntentStreamFilter();
        return event;
      case 'delta': {
        const text = visibleDelta(event.text);
        return text ? { ...event, text } : null;
      }
      case 'reasoning': {
        const text = visibleReasoning(event.text);
        return text ? { ...event, text } : null;
      }
      case 'done':
        return { ...event, text: parseMemoryIntent(event.text).cleanedResponse };
      default:
        return event;
    }
  };
}

function parseJsonObject(jsonText: string): Record<string, unknown> | null {
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toMemoryIntent(fields: Record<string, unknown> | null): MemoryIntent | null {
  if (!fields) {
    return null;
  }
  const { level, confidence } = fields;
  const reason = normalizeString(fields.reason, 280);
  const summary = normalizeString(fields.summary, 280);

  if (!isValidLevel(level) || !isValidConfidence(confidence) || !reason) {
    return null;
  }
  return { level, confidence, reason, ...(summary ? { summary } : {}) };
}

/** 從 `{` 找到對應的 `}`,字串內的括號不算。掃描上限是下一個標記開頭,所以總耗時與回覆長度成正比。 */
function findJsonEnd(text: string, open: number, limit: number): number | null {
  let depth = 0;
  let inString = false;
  for (let index = open; index < limit; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && text[cursor]!.trim() === '') {
    cursor += 1;
  }
  return cursor;
}

/**
 * 判斷不出是標記時保留文字:露出標記比無聲吃掉正文好。
 * 完整標記可以跨行,但必須是有效 JSON;格式壞掉的標記只處理到同一行的 `]]`。
 */
function readIntentBlock(text: string, start: number): IntentBlock | null {
  const afterStart = start + INTENT_MARKER_START.length;
  const open = skipWhitespace(text, afterStart);
  const nextStart = text.indexOf(INTENT_MARKER_START, afterStart);
  const limit = nextStart === -1 ? text.length : nextStart;

  if (text[open] === '{') {
    const jsonEnd = findJsonEnd(text, open, limit);
    if (jsonEnd !== null) {
      const close = skipWhitespace(text, jsonEnd);
      const fields = parseJsonObject(text.slice(open, jsonEnd));
      if (fields && text.startsWith(INTENT_MARKER_END, close)) {
        return { start, end: close + INTENT_MARKER_END.length, fields };
      }
    }
  }

  const untilNext = text.slice(afterStart, limit);
  const line = untilNext.split('\n', 1)[0] ?? '';
  const closeOnLine = line.indexOf(INTENT_MARKER_END);
  if (closeOnLine !== -1) {
    return { start, end: afterStart + closeOnLine + INTENT_MARKER_END.length, fields: null };
  }

  // 模型輸出被截斷時標記沒有收尾,只有回覆的最後一行才能確定後面沒有正文。
  const isLastLine = nextStart === -1 && line.length === untilNext.length;
  return text[open] === '{' && isLastLine ? { start, end: text.length, fields: null } : null;
}

function findIntentBlocks(text: string): IntentBlock[] {
  const blocks: IntentBlock[] = [];
  let cursor = text.indexOf(INTENT_MARKER_START);
  while (cursor !== -1) {
    const block = readIntentBlock(text, cursor);
    if (block) {
      blocks.push(block);
    }
    const searchFrom = block ? block.end : cursor + INTENT_MARKER_START.length;
    cursor = text.indexOf(INTENT_MARKER_START, searchFrom);
  }
  return blocks;
}

/** 接合區塊前後的文字時優先保留換行,段落、清單與 Markdown 標題才不會黏在一起。 */
function widerGap(left: string, right: string): string {
  const leftBreaks = left.includes('\n');
  if (leftBreaks !== right.includes('\n')) {
    return leftBreaks ? left : right;
  }
  return left.length >= right.length ? left : right;
}

function removeIntentBlocks(text: string, blocks: IntentBlock[]): string {
  const parts: string[] = [];
  let gap = '';
  let cursor = 0;
  for (const { start, end } of [...blocks, { start: text.length, end: text.length }]) {
    const segment = text.slice(cursor, start);
    cursor = end;
    const body = segment.trim();
    if (!body) {
      gap = widerGap(gap, segment);
      continue;
    }
    const leading = segment.slice(0, segment.length - segment.trimStart().length);
    parts.push(widerGap(gap, leading), body);
    gap = segment.slice(segment.trimEnd().length);
  }
  return parts.join('').trim();
}

/**
 * 移除回覆裡所有標記。intent 只採用結尾的標記:提示要求標記放在回覆最後,
 * 中段的標記可能是模型引用的範例,不能寫成長期記憶。
 */
export function parseMemoryIntent(response: string): ParsedMemoryIntent {
  const blocks = findIntentBlocks(response);
  const last = blocks.at(-1);
  if (!last) {
    return { cleanedResponse: response, intent: null };
  }

  return {
    cleanedResponse: removeIntentBlocks(response, blocks),
    intent: response.slice(last.end).trim() === '' ? toMemoryIntent(last.fields) : null
  };
}
