/**
 * Prompt 組裝與記憶體上下文建構
 */
import type { ChatPromptConfig } from '../config/ai-config.js';
import type { MemoryManager } from '../core/memory.js';

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

export function buildMemoryContext(
  memory: MemoryManager,
  userId: string,
  userMessage: string
): string {
  const recent = memory.getRecentMessages(userId, 80);
  if (recent.length === 0) {
    return '';
  }

  const keywords = extractQueryKeywords(userMessage);
  const loweredKeywords = keywords.map((item) => item.toLowerCase());
  const currentMessage = userMessage.trim();

  const scored = recent
    .filter((item) => item.content.trim().length > 0 && item.content.trim() !== currentMessage)
    .map((item) => {
      const content = item.content.toLowerCase();
      let score = 0;
      for (const keyword of loweredKeywords) {
        if (content.includes(keyword)) {
          score += 1;
        }
      }
      return { ...item, score };
    });

  const matches =
    loweredKeywords.length > 0
      ? scored
          .filter((item) => item.score > 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.timestamp - a.timestamp;
          })
          .slice(0, 5)
      : [];

  const fallbackRecent = recent.slice(0, 3);
  const selected = matches.length > 0 ? matches : fallbackRecent;

  if (selected.length === 0) {
    return '';
  }

  const lines = selected.map((item) => {
    const role = item.role === 'user' ? 'User' : 'AI';
    const time = new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    return `- [${role}] (${time}) ${truncateInline(item.content, 180)}`;
  });

  return ['【記憶參考（TeleNexus）】', ...lines].join('\n');
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
    sections.push(memoryContext.trim());
  }

  sections.push(`User Message:\n${userMessage}`);

  if (config.includeAiResponseSuffix) {
    sections.push('AI Response:');
  }

  return sections.join('\n\n').trim();
}
