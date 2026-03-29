import type { ChatMessage } from './memory.js';

export function fingerprintReflection(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function isReflectionMessage(content: string): boolean {
  return (
    content.startsWith('🔔 [追蹤提醒]') ||
    content.startsWith('🔍 [手動追蹤]') ||
    content.startsWith('✅ [追蹤檢查]') ||
    content === '✨ 無待辦。' ||
    content.startsWith('❌ 追蹤提醒執行失敗：')
  );
}

export function hasUserActivitySinceLastReflection(extendedHistory: ChatMessage[]): boolean {
  let lastUserTimestamp: number | null = null;
  let lastReflectionTimestamp: number | null = null;

  for (const message of extendedHistory) {
    if (message.role === 'user') {
      lastUserTimestamp = message.timestamp;
      continue;
    }

    if (isReflectionMessage(message.content)) {
      lastReflectionTimestamp = message.timestamp;
    }
  }

  if (lastReflectionTimestamp === null) {
    return true;
  }

  return lastUserTimestamp !== null && lastUserTimestamp > lastReflectionTimestamp;
}

export function extractKeywords(text: string): string[] {
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

export function truncateInline(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength - 1) + '…';
}

export function normalizeProviderPrefix(response: string): string {
  return response
    .trim()
    .replace(/^\[(Gemini|Opencode)\]\s*/i, '')
    .trim();
}

export function looksLikeConcreteResult(normalized: string): boolean {
  if (!normalized) {
    return false;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bulletCount = lines.filter((line) => /^[-*•]|^\d+\./.test(line)).length;
  const hasDataPattern =
    /\d+([.,]\d+)?%|\$\d+|\d{2,}|支撐|阻力|趨勢|風險|建議|結論|觀察|重點|摘要|分析/.test(
      normalized
    );

  return normalized.length >= 90 || bulletCount >= 2 || hasDataPattern;
}

export function assessAiResponse(response: string): {
  shouldRetry: boolean;
  reason: string;
  normalized: string;
} {
  const normalized = normalizeProviderPrefix(response);
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { shouldRetry: true, reason: 'empty_response', normalized };
  }

  if (/^Error calling (Gemini|Opencode):/i.test(normalized)) {
    return { shouldRetry: true, reason: 'provider_error', normalized };
  }
  if (normalized.startsWith('Error calling runner:')) {
    return { shouldRetry: true, reason: 'runner_error', normalized };
  }
  if (/^✨\s*\d+\s*分鐘內未完成/.test(normalized)) {
    return { shouldRetry: true, reason: 'timeout', normalized };
  }
  if (/process terminated with signal sigkill/.test(lower)) {
    return { shouldRetry: true, reason: 'sigkill', normalized };
  }
  if (/process exited with code 1/.test(lower)) {
    return { shouldRetry: true, reason: 'exit_code_1', normalized };
  }

  const looksLikeExecutionStub =
    /^(我將|我會|我先|接下來|將會)/.test(normalized) &&
    /(執行|調用|呼叫|run|execute|處理|分析)/i.test(normalized);
  if (looksLikeExecutionStub && !looksLikeConcreteResult(normalized)) {
    return { shouldRetry: true, reason: 'stub_without_result', normalized };
  }

  return { shouldRetry: false, reason: 'ok', normalized };
}

export function buildMemoryContextLines(matches: ChatMessage[]): string[] {
  return matches.map((item) => {
    const role = item.role === 'user' ? 'User' : 'AI';
    const time = new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    return `- [${role}] (${time}) ${truncateInline(item.content, 180)}`;
  });
}

export function buildScheduledTaskPrompt(
  scheduleName: string,
  schedulePrompt: string,
  longTermMemory = ''
): string {
  return `
System: 你是 TeleNexus，一個具備強大工具執行能力的本地 AI 助理。
這是一個排程任務觸發的自動執行。
請用繁體中文回應。

重要：請直接回覆「最終結果」，不要只回答「我將執行...」。
格式可彈性，但至少包含：
- 核心結論（1 段）
- 2~5 點具體觀察或數據
- 可執行的下一步建議（若無可略）

${longTermMemory ? longTermMemory + '\n\n' : ''}
Scheduled Task: ${scheduleName}
User Request: ${schedulePrompt}

Final Result:
`.trim();
}

export function buildReflectionPrompt(
  userHistoryText: string,
  modelHistoryText: string,
  longTermMemory = ''
): string {
  return `
System: 你是 TeleNexus，正在執行「追蹤提醒」任務。
請用繁體中文回應。

${longTermMemory ? longTermMemory + '\n\n' : ''}【任務說明】
請分析過去 24 小時的對話歷史，輸出可快速掃讀的分類摘要。
聚焦真正需要跟進的事項，避免冗長描述與固定前言。

【嚴格限制】
- 「User 訊息」是主證據；「AI 訊息」只能作為補充上下文
- 若某項目僅出現在 AI 訊息、未出現在 User 訊息，禁止列入待辦/問題
- 不可引用 AI 先前推測、假設、或未經使用者確認的專有名詞
- 若資訊不足，請明確寫「資訊不足，待使用者確認」

【證據標註規則】
- 每一項都要標註 evidence: user | mixed
- confidence 僅可為 high | medium | low
- 僅當 evidence=user 或 evidence=mixed 時，該項目才可列入輸出

【過去 24 小時 User 對話（主證據）】
${userHistoryText}

【過去 24 小時 AI 對話（僅供上下文）】
${modelHistoryText || '(none)'}

【輸出格式】
請嚴格使用以下格式（3 個分類都必須出現）：

🔴 未解決的問題：
- <項目>（evidence=<user|mixed>, confidence=<high|medium|low>）

🟡 可優化事項：
- <項目>（evidence=<user|mixed>, confidence=<high|medium|low>）

🟢 待辦提醒：
- <項目>（evidence=<user|mixed>, confidence=<high|medium|low>）

規則：
- 每個分類最多 2 點，總點數最多 5 點。
- 每點最多 2 句，句子要短。
- 禁止加入前言/結語（例如「我已分析」「以下為摘要」「已自動儲存」）。
- 若某分類沒有內容，該分類請填「- 無」。

若三個分類皆為「無」，請只輸出「近期對話無待處理事項」。
你的回應會自動儲存到記憶系統中，供未來參考。
`.trim();
}

export function buildDailySummaryPrompt(dateLabel: string): string {
  return `
System: 你是 TeleNexus，正在執行「每日對話摘要」任務。
請用繁體中文回應。

【任務說明】
請回顧最近的對話記錄，輸出高密度、可快速掃讀的每日摘要。
以決策價值與可行動性為優先，避免固定模板、空話與重複句。

【輸出格式】
📅 每日摘要 - ${dateLabel}

🔴 高優先：
- ...

🟡 可優化：
- ...

🟢 已解決 / 低優先：
- ...

➡️ 下一步：
- ...

規則：
- 三個分類都必須出現。
- 每個分類最多 1 點，總點數最多 3 點。
- 每點最多 1 句，句子短，不超過 28 個中文字為佳。
- 若某分類沒有內容，該分類請填「- 無」。
- 「➡️ 下一步」最多 2 點，只寫真正可執行的行動。
- 禁止加入前言/結語（例如「我已分析」「以下為摘要」）。
- 禁止重述顯而易見的背景，直接寫結論。

如果三個分類都為「無」且無行動，請回覆「✨ 目前沒有待處理事項！」
`.trim();
}
