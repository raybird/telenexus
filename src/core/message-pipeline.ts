import type { Connector, UnifiedMessage } from '../types/index.js';
import type { AIAgent } from './agent.js';
import type { CommandRouter } from './command-router.js';
import { executionQueue } from './execution-queue.js';
import {
  maybeSendSummaryFollowup,
  persistModelResponse,
  persistUserMessage,
  preparePromptForAgent
} from './message-pipeline-chat.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import type { MemoryManager } from './memory.js';
import {
  consumePendingImages,
  deliverFileDirectives,
  extractFileDirectives,
  parsePendingImageTtlMs,
  ThinkingMessenger,
  type PendingImageBundle
} from './message-pipeline-helpers.js';
import type { Scheduler } from './scheduler.js';
import { parseBool, parsePositiveInt } from '../utils/env.js';

type MessagePipelineOptions = {
  connector: Connector;
  resolveConnector?: (msg: UnifiedMessage) => Connector;
  commandRouter: CommandRouter;
  memory: MemoryManager;
  scheduler: Scheduler;
  userAgent: AIAgent;
  chatRunnerAgent: AIAgent;
  useRunnerForChat: boolean;
  chatRunnerPercent: number;
  chatRunnerOnlyUsers: Set<string>;
  shouldSummarize: (content: string) => boolean;
  buildPrompt: (userMessage: string, userId: string, mode?: 'full' | 'compact') => string;
  enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void;
  recordRuntimeIssue: (scope: string, error: unknown) => void;
  writeContextSnapshots: () => void;
};

function hashToBucket(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function createMessagePipeline(options: MessagePipelineOptions) {
  const pendingNewSessionUsers = new Set<string>();
  const fullPromptCounterByUser = new Map<string, number>();
  const pendingImageByUser = new Map<string, PendingImageBundle>();
  const pendingImageTtlMs = parsePendingImageTtlMs(process.env.IMAGE_ATTACHMENT_PENDING_TTL_MS);
  const maxSendFileBytes = 45 * 1024 * 1024;
  const summaryFollowupEnabled = parseBool(process.env.SUMMARY_FOLLOWUP_ENABLED, true);
  const fullPromptEvery = parsePositiveInt(process.env.CHAT_FULL_PROMPT_EVERY, 6);
  const summaryFollowupMinLength = parsePositiveInt(process.env.SUMMARY_FOLLOWUP_MIN_LENGTH, 500);
  const summaryFollowupMaxLength = parsePositiveInt(process.env.SUMMARY_FOLLOWUP_MAX_LENGTH, 320);
  const thinkingMessages = [
    '🤔 思考中...',
    '🧠 正在理解問題...',
    '🔍 搜尋相關資訊...',
    '⚡ 處理中...',
    '💭 組織回答...',
    '🎯 分析脈絡...'
  ];

  return async (incomingMsg: UnifiedMessage): Promise<void> => {
    const now = Date.now();
    let msg = incomingMsg;
    const connector = options.resolveConnector?.(msg) || options.connector;
    const attachmentCount = msg.attachments?.length || 0;
    console.log(
      `📩 [${msg.sender.platform}] ${msg.sender.name}: ${msg.content}${attachmentCount > 0 ? ` (attachments=${attachmentCount})` : ''}`
    );
    const userId = msg.sender.id;
    const targetChatId = msg.chatId || userId;

    const pendingImageResult = consumePendingImages(
      msg,
      pendingImageByUser,
      now,
      pendingImageTtlMs
    );
    if (pendingImageResult.kind === 'stored') {
      await connector.sendMessage(
        targetChatId,
        '📎 已收到圖片。請再傳一則文字描述你要我做的事，我會搭配圖片一起處理。'
      );
      return;
    }
    msg = pendingImageResult.message;

    options.scheduler.resetSilenceTimer(userId);
    options.writeContextSnapshots();

    const commandHandled = await options.commandRouter.handleMessage(msg, {
      connector,
      memory: options.memory,
      scheduler: options.scheduler,
      requestNewSession: (targetUserId: string) => {
        pendingNewSessionUsers.add(targetUserId);
      }
    });
    if (commandHandled) {
      return;
    }

    const isPassthroughCommand = options.commandRouter.isPassthroughCommand(msg.content.trim());
    const forceNewSession = pendingNewSessionUsers.has(userId);
    if (forceNewSession) {
      pendingNewSessionUsers.delete(userId);
      console.log('[System] Applying one-time new session mode for this message.');
    }

    const queueStatus = executionQueue.getStatus(userId);
    if (queueStatus.running || queueStatus.pending > 0) {
      const ahead = queueStatus.pending + (queueStatus.running ? 1 : 0);
      await connector.sendMessage(
        targetChatId,
        `⏳ 目前有任務執行中（來源：${queueStatus.currentSource || 'unknown'}），已幫你排隊，前方約 ${ahead} 件。`,
        {
          retries: 1,
          retryOnTimeout: false
        }
      );
    }

    const isWhitelisted =
      options.chatRunnerOnlyUsers.size === 0 || options.chatRunnerOnlyUsers.has(msg.sender.id);
    const bucket = hashToBucket(`${msg.sender.id}:${msg.id}`);
    const useRunnerThisMessage =
      options.useRunnerForChat && isWhitelisted && bucket < options.chatRunnerPercent;
    const activeAgent = useRunnerThisMessage ? options.chatRunnerAgent : options.userAgent;
    console.log(
      `[System] Message execution mode: ${useRunnerThisMessage ? 'runner' : 'local'} (bucket=${bucket}, canary=${options.chatRunnerPercent}%, whitelist=${isWhitelisted})`
    );

    const thinkingMessenger = new ThinkingMessenger(connector, targetChatId, thinkingMessages);
    await thinkingMessenger.start();

    try {
      await persistUserMessage({
        memory: options.memory,
        activeAgent,
        userId,
        content: msg.content,
        isPassthroughCommand,
        shouldSummarize: options.shouldSummarize
      });

      const promptForAgent = preparePromptForAgent({
        msgContent: msg.content,
        userId,
        isPassthroughCommand,
        forceNewSession,
        fullPromptEvery,
        fullPromptCounterByUser,
        buildPrompt: options.buildPrompt,
        ...(msg.attachments ? { attachments: msg.attachments } : {})
      });

      if (isPassthroughCommand) {
        console.log(`📤 [System] Passthrough command -> CLI: ${promptForAgent}`);
      } else {
        console.log(`📤 [System] Sending prompt to AI (length: ${promptForAgent.length} chars)`);
      }

      const rawResponse = await executionQueue.enqueue(userId, 'chat', 'high', () =>
        activeAgent.chat(promptForAgent, {
          isPassthroughCommand,
          forceNewSession,
          autoRecoveryNotice: true
        })
      );

      const { cleanedText, directives } = extractFileDirectives(rawResponse);
      const response = cleanedText || rawResponse;

      console.log(`📥 [AI] Reply length: ${response.length}`);

      const modelMessageTimestamp = persistModelResponse({
        memory: options.memory,
        userId,
        userMessage: msg.content,
        response,
        platform: msg.sender.platform,
        isPassthroughCommand,
        forceNewSession,
        ...(options.enqueueMemoriaSync ? { enqueueMemoriaSync: options.enqueueMemoriaSync } : {})
      });

      await thinkingMessenger.stop();
      await thinkingMessenger.deliverFinalResponse(response);

      if (directives.length > 0) {
        await deliverFileDirectives(connector, targetChatId, directives, maxSendFileBytes);
      }

      maybeSendSummaryFollowup({
        enabled: summaryFollowupEnabled,
        isPassthroughCommand,
        response,
        minLength: summaryFollowupMinLength,
        maxLength: summaryFollowupMaxLength,
        shouldSummarize: options.shouldSummarize,
        memory: options.memory,
        activeAgent,
        userId,
        connectorSendMessage: (text) => connector.sendMessage(targetChatId, text),
        ...(typeof modelMessageTimestamp === 'number' ? { modelMessageTimestamp } : {})
      });
    } catch (error) {
      console.error('❌ Error processing message:', error);
      options.recordRuntimeIssue('message-processing', error);
      options.writeContextSnapshots();
      const errorMsg = 'Sorry, I encountered an error while exercising my powers.';

      await thinkingMessenger.stop();
      await thinkingMessenger.deliverFinalResponse(errorMsg);
    }
  };
}
