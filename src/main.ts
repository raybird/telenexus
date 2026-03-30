import dotenv from 'dotenv';
import { TelegramConnector } from './connectors/telegram.js';
import { CommandRouter } from './core/command-router.js';
import { DynamicAIAgent } from './core/agent.js';
import { MemoryManager } from './core/memory.js';
import { MemoriaSyncBridge } from './core/memoria-sync.js';
import { createMessagePipeline } from './core/message-pipeline.js';
import { Scheduler } from './core/scheduler.js';
import { startWebServer } from './web/server.js';
import { parseBool, parsePositiveInt, parseNumber } from './utils/env.js';
import { loadChatPromptConfig } from './config/ai-config.js';
import { shouldSummarize, buildMemoryContext, buildChatPrompt } from './prompt/builder.js';
import { recordRuntimeIssue } from './utils/errors.js';
import { writeContextSnapshots, writeSchedulerHealth } from './services/context-snapshots.js';
import { MemoryBackfillWorker } from './services/memory-backfill-worker.js';
import type { UnifiedMessage } from './types/index.js';

// 載入環境變數
dotenv.config();

function getContextRefreshMs(): number {
  return parsePositiveInt(process.env.CONTEXT_REFRESH_MS, 60000);
}

function getChatRunnerPercent(): number {
  const raw = process.env.CHAT_USE_RUNNER_PERCENT?.trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
}

function getRunnerFailureThreshold(): number {
  return parsePositiveInt(process.env.RUNNER_FAILURE_THRESHOLD, 3);
}

function getRunnerCooldownMs(): number {
  const raw = process.env.RUNNER_COOLDOWN_MS?.trim();
  if (!raw) return 60000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) return 60000;
  return parsed;
}

function getWebEnabled(): boolean {
  return parseBool(process.env.WEB_ENABLED, true);
}

function getWebBindHost(): string {
  return process.env.WEB_BIND?.trim() || '127.0.0.1';
}

function getWebPort(): number {
  return parsePositiveInt(process.env.WEB_PORT, 3030);
}

function getWebTrustPrivateNetwork(): boolean {
  return parseBool(process.env.WEB_TRUST_PRIVATE_NETWORK, false);
}

function getWebAlertErrorThreshold(): number {
  const raw = process.env.WEB_ALERT_ERROR_THRESHOLD?.trim();
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

function getWebAlertRunnerSuccessWarnThreshold(): number {
  const value = parseNumber(process.env.WEB_ALERT_RUNNER_SUCCESS_WARN_THRESHOLD, 80);
  return Math.min(100, Math.max(0, value));
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
  const enqueueMemoriaSyncFn = (turn: Parameters<typeof memoriaSync.enqueueTurn>[0]) => {
    memoriaSync.enqueueTurn(turn);
  };
  const scheduler = new Scheduler(memory, schedulerAgent, telegram, enqueueMemoriaSyncFn);
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

  const buildPromptFn = (
    userMessage: string,
    userId: string,
    mode: 'full' | 'compact' = 'full'
  ) => {
    const promptConfig = loadChatPromptConfig();
    const memoryContext = buildMemoryContext(memory, userId, userMessage);
    return buildChatPrompt(promptConfig, userMessage, memoryContext, mode);
  };

  const writeContextSnapshotsFn = () => {
    writeContextSnapshots(memory);
  };
  const memoryBackfillWorker = new MemoryBackfillWorker({
    onAfterRun: writeContextSnapshotsFn
  });

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
    buildPrompt: buildPromptFn,
    enqueueMemoriaSync: enqueueMemoriaSyncFn,
    recordRuntimeIssue,
    writeContextSnapshots: writeContextSnapshotsFn
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
    buildPrompt: buildPromptFn,
    enqueueMemoriaSync: enqueueMemoriaSyncFn,
    recordRuntimeIssue,
    writeContextSnapshots: writeContextSnapshotsFn
  });

  // 註冊優雅關閉處理器
  process.on('SIGINT', () => {
    console.log('\n[System] Shutting down gracefully...');
    stopContextRefresh();
    memoryBackfillWorker.shutdown();
    scheduler.shutdown();
    void webServer.close().finally(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.log('\n[System] Shutting down gracefully...');
    stopContextRefresh();
    memoryBackfillWorker.shutdown();
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
  memoryBackfillWorker.start();

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
