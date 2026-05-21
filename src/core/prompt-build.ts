export type PromptMode = 'full' | 'compact' | 'minimal';

export type PromptBuildResult = {
  prompt: string;
  mode: PromptMode;
  memoryContextLength: number;
  usedMemoryContext: boolean;
  memoryContextSectionCount: number;
};

const COMPACT_MEMORY_KEYWORDS = [
  /之前/,
  /上次/,
  /剛剛/,
  /目前/,
  /現在/,
  /記得/,
  /延續/,
  /沿用/,
  /規則/,
  /決策/,
  /摘要/,
  /脈絡/,
  /背景/,
  /sop/i,
  /workflow/i,
  /release/i,
  /scheduler/i,
  /runner/i,
  /opencode/i,
  /memory/i,
  /session/i,
  /fallback/i,
  /compress/i,
  /compact/i,
  /web chat/i,
  /歷史/,
  /設定/,
  /配置/
];

export function shouldIncludeMemoryContext(mode: PromptMode, userMessage: string): boolean {
  if (mode === 'full') {
    return true;
  }

  if (mode === 'minimal') {
    return false;
  }

  const trimmed = userMessage.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.length >= 80) {
    return true;
  }

  if ((trimmed.match(/\n/g) || []).length >= 1) {
    return true;
  }

  if (/```|tool_result:|\[\[SEND_FILE:/.test(trimmed)) {
    return true;
  }

  if (COMPACT_MEMORY_KEYWORDS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  if (
    /(如何|怎麼|為什麼|是什麼|哪個|哪一個|要不要).{0,20}(規則|做法|流程|設定|配置|SOP)/.test(
      trimmed
    )
  ) {
    return true;
  }

  return false;
}

export function normalizePromptBuildResult(
  result: string | PromptBuildResult,
  fallbackMode: PromptMode
): PromptBuildResult {
  if (typeof result === 'string') {
    return {
      prompt: result,
      mode: fallbackMode,
      memoryContextLength: 0,
      usedMemoryContext: false,
      memoryContextSectionCount: 0
    };
  }

  return result;
}
