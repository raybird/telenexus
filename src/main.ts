import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { TelegramConnector } from './connectors/telegram.js';
import { CommandRouter } from './core/command-router.js';
import { DynamicAIAgent } from './core/agent.js';
import { MemoryManager } from './core/memory.js';
import { MemoriaSyncBridge } from './core/memoria-sync.js';
import { createMessagePipeline } from './core/message-pipeline.js';
import { Scheduler } from './core/scheduler.js';
import { startWebServer } from './web/server.js';
import type { UnifiedMessage } from './types/index.js';

// 載入環境變數
dotenv.config();

/**
 * 判斷是否需要生成摘要
 * 簡化的觸發條件：字元長度 + 程式碼區塊 + 行數
 */
function shouldSummarize(content: string): boolean {
  // 條件 1: 超過 200 字元
  if (content.length > 200) return true;

  // 條件 2: 包含程式碼區塊或工具輸出
  if (content.includes('```') || content.includes('tool_result')) return true;

  // 條件 3: 超過 6 行
  if ((content.match(/\n/g) || []).length >= 6) return true;

  return false;
}

type RuntimeIssue = {
  timestamp: number;
  scope: string;
  message: string;
};

type ChatPromptConfig = {
  language: string;
  roleSystem: string;
  yoloNoticeEnabled: boolean;
  memoryPolicyEnabled: boolean;
  workspacePolicyEnabled: boolean;
  includeAiResponseSuffix: boolean;
  memoryPolicyLines: string[];
  workspacePolicyLines: string[];
};

const DEFAULT_CHAT_PROMPT_CONFIG: ChatPromptConfig = {
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

const RECENT_ISSUE_LIMIT = 20;
const recentIssues: RuntimeIssue[] = [];

function loadAiConfigRaw(): Record<string, unknown> | undefined {
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

function loadChatPromptConfig(): ChatPromptConfig {
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

function buildChatPrompt(
  config: ChatPromptConfig,
  userMessage: string,
  memoryContext = ''
): string {
  const sections: string[] = [];

  sections.push('System: ' + config.roleSystem);

  if (config.yoloNoticeEnabled) {
    sections.push('現在已經開啟了 YOLO 模式，你的所有工具調用都會被自動允許。');
  }

  sections.push(`請用${config.language}回應。`);

  if (config.memoryPolicyEnabled) {
    const lines = config.memoryPolicyLines.map((line) => `- ${line}`).join('\n');
    sections.push(`【知識管理 - 重要】\n你有 MCP Memory 工具可以儲存長期知識與關係：\n${lines}`);
  }

  if (config.workspacePolicyEnabled) {
    const lines = config.workspacePolicyLines.map((line) => `- ${line}`).join('\n');
    sections.push(`【工作目錄限制 - 重要】\n${lines}`);
  }

  sections.push(
    '【檔案回傳協議】\n若使用者要求你把檔案直接傳到 Telegram，請先將檔案輸出到 workspace/temp/，再在回覆中加入標記：[[SEND_FILE: workspace/temp/檔名 | 可選說明]]。\n可同時放多個標記，系統會依序送出檔案。'
  );

  if (memoryContext.trim().length > 0) {
    sections.push(memoryContext.trim());
  }

  sections.push(`User Message:\n${userMessage}`);

  if (config.includeAiResponseSuffix) {
    sections.push('AI Response:');
  }

  return sections.join('\n\n').trim();
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

function buildMemoryContext(memory: MemoryManager, userId: string, userMessage: string): string {
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function recordRuntimeIssue(scope: string, error: unknown): void {
  recentIssues.push({
    timestamp: Date.now(),
    scope,
    message: toErrorMessage(error)
  });
  if (recentIssues.length > RECENT_ISSUE_LIMIT) {
    recentIssues.splice(0, recentIssues.length - RECENT_ISSUE_LIMIT);
  }
}

function loadProviderStatus(): { provider: string; model: string; timezone: string } {
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

function resolveSchedulerHealthPath(): string {
  const explicitPath = process.env.DB_PATH?.trim();
  if (explicitPath) {
    return path.resolve(path.dirname(explicitPath), 'scheduler-health.json');
  }

  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir, 'scheduler-health.json');
  }

  return path.resolve(process.cwd(), 'scheduler-health.json');
}

function writeSchedulerHealth(trigger: string, memory: MemoryManager): void {
  try {
    const healthPath = resolveSchedulerHealthPath();
    const payload = {
      updatedAt: Date.now(),
      lastReloadAt: Date.now(),
      lastLoadedScheduleCount: memory.getActiveSchedules().length,
      trigger,
      pid: process.pid
    };

    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    fs.writeFileSync(healthPath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.warn('[System] Failed to write scheduler health marker:', error);
  }
}

function resolveContextDir(): string {
  const projectDir = process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
  return path.resolve(projectDir, 'workspace', 'context');
}

function writeContextSnapshots(memory: MemoryManager): void {
  try {
    const contextDir = resolveContextDir();
    fs.mkdirSync(contextDir, { recursive: true });

    const now = new Date();
    const provider = loadProviderStatus();
    const runtimeStatus = [
      '# Runtime Status',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      `- Node PID: ${process.pid}`,
      `- NODE_ENV: ${process.env.NODE_ENV || 'unknown'}`,
      `- Provider Config File: ai-config.yaml`,
      `- Active Provider: ${provider.provider}`,
      `- Active Model: ${provider.model}`,
      `- Timezone (TZ): ${process.env.TZ || 'Asia/Taipei (default)'}`,
      `- Runner Endpoint: ${process.env.RUNNER_ENDPOINT || '(disabled)'}`,
      `- Scheduler Runner Mode: ${process.env.SCHEDULE_USE_RUNNER || 'false'}`,
      `- Chat Runner Percent: ${process.env.CHAT_USE_RUNNER_PERCENT || '0'}`,
      `- Chat Runner Whitelist: ${process.env.CHAT_USE_RUNNER_ONLY_USERS || '(all users)'}`,
      `- Runner Failure Threshold: ${process.env.RUNNER_FAILURE_THRESHOLD || '3'}`,
      `- Runner Cooldown (ms): ${process.env.RUNNER_COOLDOWN_MS || '60000'}`,
      `- DB_PATH: ${process.env.DB_PATH || '(auto-resolved)'}`,
      `- DB_DIR: ${process.env.DB_DIR || '(not set)'}`,
      `- GEMINI_PROJECT_DIR: ${process.env.GEMINI_PROJECT_DIR || process.cwd()}`
    ].join('\n');

    const providerStatus = [
      '# Provider Status',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      `- Provider: ${provider.provider}`,
      `- Model: ${provider.model}`,
      `- Timezone: ${provider.timezone}`
    ].join('\n');

    const schedules = memory.getActiveSchedules();
    const schedulerLines = schedules.map((schedule) => {
      return `- #${schedule.id} | ${schedule.name} | ${schedule.cron} | user=${schedule.user_id}`;
    });
    const schedulerStatus = [
      '# Scheduler Status',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      `- Active Schedules: ${schedules.length}`,
      '',
      '## Active Schedule List',
      ...(schedulerLines.length > 0 ? schedulerLines : ['- (none)'])
    ].join('\n');

    const systemArchitecture = [
      '# System Architecture Snapshot',
      '',
      '- Input channel: Telegram -> CommandRouter -> Scheduler/Agent',
      '- Scheduler source of truth: SQLite schedules table',
      '- Agent runtime: Gemini/Opencode CLI executed from workspace/',
      '- Long-term memory: TeleNexus provider-agnostic retrieval before chat dispatch',
      '- Main runtime service: TeleNexus orchestrator'
    ].join('\n');

    const operationsPolicy = [
      '# Operations Policy',
      '',
      '- Read system context from files in workspace/context/',
      '- Do not modify application source code unless explicitly requested by user',
      '- Prefer scheduler commands via Telegram command router',
      '- In Docker, use `docker compose exec telenexus ...` for maintenance commands',
      '- Avoid using one-off `docker compose run` for scheduler modifications'
    ].join('\n');

    const recentIssueLines = recentIssues
      .slice(-10)
      .map(
        (issue) =>
          `- [${new Date(issue.timestamp).toLocaleString('zh-TW')}] (${issue.scope}) ${issue.message}`
      );
    const errorSummary = [
      '# Error Summary',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      '',
      '## Recent Runtime Issues',
      ...(recentIssueLines.length > 0 ? recentIssueLines : ['- (none)'])
    ].join('\n');

    fs.writeFileSync(path.join(contextDir, 'runtime-status.md'), runtimeStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'provider-status.md'), providerStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'scheduler-status.md'), schedulerStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'system-architecture.md'), systemArchitecture, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'operations-policy.md'), operationsPolicy, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'error-summary.md'), errorSummary, 'utf8');
  } catch (error) {
    console.warn('[System] Failed to write context snapshots:', error);
  }
}

function getContextRefreshMs(): number {
  const raw = process.env.CONTEXT_REFRESH_MS?.trim();
  if (!raw) return 60000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 10000) {
    return 60000;
  }
  return parsed;
}

function getChatRunnerPercent(): number {
  const raw = process.env.CHAT_USE_RUNNER_PERCENT?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
}

function getRunnerFailureThreshold(): number {
  const raw = process.env.RUNNER_FAILURE_THRESHOLD?.trim();
  if (!raw) return 3;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return parsed;
}

function getRunnerCooldownMs(): number {
  const raw = process.env.RUNNER_COOLDOWN_MS?.trim();
  if (!raw) return 60000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) return 60000;
  return parsed;
}

function getWebEnabled(): boolean {
  const raw = process.env.WEB_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getWebBindHost(): string {
  const raw = process.env.WEB_BIND?.trim();
  return raw || '127.0.0.1';
}

function getWebPort(): number {
  const raw = process.env.WEB_PORT?.trim();
  if (!raw) return 3030;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return 3030;
  }
  return parsed;
}

function getWebTrustPrivateNetwork(): boolean {
  const raw = process.env.WEB_TRUST_PRIVATE_NETWORK?.trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getWebAlertErrorThreshold(): number {
  const raw = process.env.WEB_ALERT_ERROR_THRESHOLD?.trim();
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

function getWebAlertRunnerSuccessWarnThreshold(): number {
  const raw = process.env.WEB_ALERT_RUNNER_SUCCESS_WARN_THRESHOLD?.trim();
  if (!raw) return 80;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 80;
  return Math.min(100, Math.max(0, parsed));
}

function getChatRunnerOnlyUsers(defaultUserId?: string): Set<string> {
  const raw = process.env.CHAT_USE_RUNNER_ONLY_USERS?.trim();
  if (!raw) {
    return defaultUserId ? new Set<string>([defaultUserId]) : new Set<string>();
  }
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );
}

async function bootstrap() {
  console.log('🚀 Starting TeleNexus (YOLO Agent + Stream UX)...');

  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
  const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;

  if (!TELEGRAM_TOKEN || !ALLOWED_USER_ID) {
    console.error('❌ Missing environment variables.');
    process.exit(1);
  }

  // 初始化元件
  const telegram = new TelegramConnector(TELEGRAM_TOKEN, [ALLOWED_USER_ID]);
  const userAgent = new DynamicAIAgent();
  const runnerEndpoint = process.env.RUNNER_ENDPOINT?.trim();
  const runnerToken = process.env.RUNNER_SHARED_SECRET?.trim();
  const runnerFailureThreshold = getRunnerFailureThreshold();
  const runnerCooldownMs = getRunnerCooldownMs();
  const useRunnerForSchedule =
    process.env.SCHEDULE_USE_RUNNER === 'true' && Boolean(runnerEndpoint);
  const chatRunnerPercent = getChatRunnerPercent();
  const chatRunnerOnlyUsers = getChatRunnerOnlyUsers(ALLOWED_USER_ID);
  const useRunnerForChat = chatRunnerPercent > 0 && Boolean(runnerEndpoint);
  const runnerOptions = runnerEndpoint
    ? {
        runnerEndpoint,
        ...(runnerToken ? { runnerToken } : {}),
        runnerFailureThreshold,
        runnerCooldownMs,
        preferRunner: true,
        fallbackToLocal: true
      }
    : undefined;
  const schedulerAgent = useRunnerForSchedule
    ? new DynamicAIAgent('ai-config.yaml', runnerOptions)
    : userAgent;
  const chatRunnerAgent = useRunnerForChat
    ? new DynamicAIAgent('ai-config.yaml', runnerOptions)
    : userAgent;
  console.log(
    `[System] Scheduler execution mode: ${useRunnerForSchedule ? `runner (${runnerEndpoint})` : 'local'}`
  );
  console.log(
    `[System] Chat runner canary: ${useRunnerForChat ? `${chatRunnerPercent}% via ${runnerEndpoint}` : 'disabled'}`
  );
  if (chatRunnerOnlyUsers.size > 0) {
    console.log(`[System] Chat runner whitelist: ${Array.from(chatRunnerOnlyUsers).join(', ')}`);
  }
  const memory = new MemoryManager();
  const memoriaSync = new MemoriaSyncBridge();
  const scheduler = new Scheduler(memory, schedulerAgent, telegram);
  const commandRouter = new CommandRouter();
  let contextRefreshTimer: NodeJS.Timeout | null = null;
  const webEnabled = getWebEnabled();
  const webHost = getWebBindHost();
  const webPort = getWebPort();
  const webAuthToken = process.env.WEB_AUTH_TOKEN?.trim();
  const webUserId = process.env.WEB_USER_ID?.trim() || ALLOWED_USER_ID;
  const webTrustPrivateNetwork = getWebTrustPrivateNetwork();
  const webAlertErrorThreshold = getWebAlertErrorThreshold();
  const webAlertRunnerSuccessWarnThreshold = getWebAlertRunnerSuccessWarnThreshold();

  const handleIncomingMessage = createMessagePipeline({
    connector: telegram,
    commandRouter,
    memory,
    scheduler,
    userAgent,
    chatRunnerAgent,
    useRunnerForChat,
    chatRunnerPercent,
    chatRunnerOnlyUsers,
    shouldSummarize,
    buildPrompt: (userMessage: string, userId: string) => {
      const promptConfig = loadChatPromptConfig();
      const memoryContext = buildMemoryContext(memory, userId, userMessage);
      return buildChatPrompt(promptConfig, userMessage, memoryContext);
    },
    enqueueMemoriaSync: (turn) => {
      memoriaSync.enqueueTurn(turn);
    },
    recordRuntimeIssue,
    writeContextSnapshots: () => {
      writeContextSnapshots(memory);
    }
  });

  const stopContextRefresh = () => {
    if (contextRefreshTimer) {
      clearInterval(contextRefreshTimer);
      contextRefreshTimer = null;
    }
  };

  const webServer = startWebServer({
    enabled: webEnabled,
    host: webHost,
    port: webPort,
    ...(webAuthToken ? { authToken: webAuthToken } : {}),
    trustPrivateNetwork: webTrustPrivateNetwork,
    alertErrorThreshold: webAlertErrorThreshold,
    alertRunnerSuccessWarnThreshold: webAlertRunnerSuccessWarnThreshold,
    defaultUserId: webUserId,
    commandRouter,
    memory,
    scheduler,
    userAgent,
    chatRunnerAgent,
    useRunnerForChat,
    chatRunnerPercent,
    chatRunnerOnlyUsers,
    shouldSummarize,
    buildPrompt: (userMessage: string, userId: string) => {
      const promptConfig = loadChatPromptConfig();
      const memoryContext = buildMemoryContext(memory, userId, userMessage);
      return buildChatPrompt(promptConfig, userMessage, memoryContext);
    },
    enqueueMemoriaSync: (turn) => {
      memoriaSync.enqueueTurn(turn);
    },
    recordRuntimeIssue,
    writeContextSnapshots: () => {
      writeContextSnapshots(memory);
    }
  });

  // 註冊優雅關閉處理器
  process.on('SIGINT', () => {
    console.log('\n[System] Shutting down gracefully...');
    stopContextRefresh();
    scheduler.shutdown();
    void webServer.close().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.log('\n[System] Shutting down gracefully...');
    stopContextRefresh();
    scheduler.shutdown();
    void webServer.close().finally(() => process.exit(0));
  });

  process.on('SIGUSR1', async () => {
    try {
      console.log('\n[System] Received SIGUSR1, reloading schedules...');
      await scheduler.reload();
      writeSchedulerHealth('signal:SIGUSR1', memory);
      writeContextSnapshots(memory);
    } catch (error) {
      console.error('[System] Failed handling SIGUSR1 reload:', error);
      recordRuntimeIssue('signal:SIGUSR1', error);
      writeContextSnapshots(memory);
    }
  });

  // 設定訊息處理邏輯
  telegram.onMessage(async (msg: UnifiedMessage) => {
    await handleIncomingMessage(msg);
  });

  // 啟動連接器 (確保 bot instance 存在)
  await telegram.initialize();

  // 啟動排程器 (可能需要發送歡迎訊息)
  await scheduler.init();
  writeSchedulerHealth('startup:init', memory);
  writeContextSnapshots(memory);

  const contextRefreshMs = getContextRefreshMs();
  contextRefreshTimer = setInterval(() => {
    writeContextSnapshots(memory);
  }, contextRefreshMs);
  contextRefreshTimer.unref();
  console.log(`[System] Context snapshots auto-refresh every ${contextRefreshMs}ms`);
}

bootstrap().catch((err) => {
  console.error('❌ Fatal Error:', err);
});

// Trigger restart to load new schedules
