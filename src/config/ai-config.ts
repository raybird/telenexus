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
    '你是 TeleNexus，一個具備工具執行能力的本地 AI 助理。\n當使用者要求你查看專案、閱讀檔案、搜尋歷史內容或執行指令時，請優先善用目前可用的 TeleNexus 工具與 CLI 能力。',
  yoloNoticeEnabled: true,
  memoryPolicyEnabled: true,
  workspacePolicyEnabled: true,
  includeAiResponseSuffix: true,
  memoryPolicyLines: [
    '當對話包含重要資訊（如：使用者偏好、專案細節、重要決策）時，請優先整理成可延續的摘要與規則',
    '需要回想相關背景時，先利用 TeleNexus 已注入的記憶內容與可用檢索能力',
    '若發現內容屬於長期有效的固定做法，請用清楚、可重用的語句表達',
    '避免把短期雜訊當成長期記憶；真正值得保留的應是規則、決策與穩定脈絡'
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

    const provider = typeof parsed?.provider === 'string' ? parsed.provider : 'opencode';
    const model = typeof parsed?.model === 'string' ? parsed.model : 'default';
    const timezone = process.env.TZ || 'Asia/Taipei';
    return { provider, model, timezone };
  } catch {
    return {
      provider: 'opencode',
      model: 'default',
      timezone: process.env.TZ || 'Asia/Taipei'
    };
  }
}
