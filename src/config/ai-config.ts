/**
 * AI 設定載入與 ChatPromptConfig 型別
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export type ChatPromptConfig = {
  language: string;
  roleSystem: string;
  yoloNoticeEnabled: boolean;
  memoryPolicyEnabled: boolean;
  workspacePolicyEnabled: boolean;
  includeAiResponseSuffix: boolean;
  memoryPolicyLines: string[];
  workspacePolicyLines: string[];
};

export const DEFAULT_CHAT_PROMPT_CONFIG: ChatPromptConfig = {
  language: '繁體中文',
  roleSystem:
    '你是 TeleNexus，一個具備強大工具執行能力的本地 AI 助理。\n當使用者要求你搜尋網路、查看檔案或執行指令時，請善用你手邊的工具（如 google_search, read_file 等）。',
  yoloNoticeEnabled: true,
  memoryPolicyEnabled: true,
  workspacePolicyEnabled: true,
  includeAiResponseSuffix: true,
  memoryPolicyLines: [
    '當對話包含重要資訊（如：使用者偏好、專案細節、重要決策）時，請主動使用 create_entities 儲存',
    '當發現實體間的關係時，使用 create_relations 建立連結',
    '需要回想相關知識時，使用 search_entities 搜尋',
    '在對話結束前，如果有值得記住的內容，請務必儲存到 Memory'
  ],
  workspacePolicyLines: [
    '你的當前工作目錄是 workspace/',
    '優先讀取 workspace/context/ 內的系統快照檔案理解運行狀態',
    '若需產生暫存資料，請放在 workspace/temp/',
    '不要主動修改應用程式原始碼或部署設定，除非使用者明確要求'
  ]
};

export function loadAiConfigRaw(): Record<string, unknown> | undefined {
  try {
    const configPath = path.resolve(process.cwd(), 'ai-config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    return yaml.load(content) as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

function toLanguageInstruction(language: string): string {
  if (language === 'zh-TW') {
    return '繁體中文';
  }
  return language;
}

export function loadChatPromptConfig(): ChatPromptConfig {
  const parsed = loadAiConfigRaw();
  const raw = (parsed?.chat_prompt || {}) as Record<string, unknown>;

  const stringOrDefault = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;

  const boolOrDefault = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

  const linesOrDefault = (value: unknown, fallback: string[]): string[] => {
    if (!Array.isArray(value)) return fallback;
    const lines = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return lines.length > 0 ? lines : fallback;
  };

  return {
    language: toLanguageInstruction(
      stringOrDefault(raw.language, DEFAULT_CHAT_PROMPT_CONFIG.language)
    ),
    roleSystem: stringOrDefault(raw.role_system, DEFAULT_CHAT_PROMPT_CONFIG.roleSystem),
    yoloNoticeEnabled: boolOrDefault(
      raw.yolo_notice_enabled,
      DEFAULT_CHAT_PROMPT_CONFIG.yoloNoticeEnabled
    ),
    memoryPolicyEnabled: boolOrDefault(
      raw.memory_policy_enabled,
      DEFAULT_CHAT_PROMPT_CONFIG.memoryPolicyEnabled
    ),
    workspacePolicyEnabled: boolOrDefault(
      raw.workspace_policy_enabled,
      DEFAULT_CHAT_PROMPT_CONFIG.workspacePolicyEnabled
    ),
    includeAiResponseSuffix: boolOrDefault(
      raw.include_ai_response_suffix,
      DEFAULT_CHAT_PROMPT_CONFIG.includeAiResponseSuffix
    ),
    memoryPolicyLines: linesOrDefault(
      raw.memory_policy_lines,
      DEFAULT_CHAT_PROMPT_CONFIG.memoryPolicyLines
    ),
    workspacePolicyLines: linesOrDefault(
      raw.workspace_policy_lines,
      DEFAULT_CHAT_PROMPT_CONFIG.workspacePolicyLines
    )
  };
}

export function loadProviderStatus(): { provider: string; model: string; timezone: string } {
  try {
    const parsed = loadAiConfigRaw();

    const provider = typeof parsed?.provider === 'string' ? parsed.provider : 'gemini';
    const model = typeof parsed?.model === 'string' ? parsed.model : 'default';
    const timezone = process.env.TZ || 'Asia/Taipei';
    return { provider, model, timezone };
  } catch {
    return {
      provider: 'gemini',
      model: 'default',
      timezone: process.env.TZ || 'Asia/Taipei'
    };
  }
}
