import type { Connector, UnifiedMessage } from '../types/index.js';
import type { AIAgent } from './agent.js';
import type { AgentEvent } from './agent-result.js';
import type { CommandRouter } from './command-router.js';
import { executionQueue } from './execution-queue.js';
import {
  maybeSendSummaryFollowup,
  normalizeAgentResponse,
  persistModelResponse,
  persistUserMessage,
  preparePromptForAgent
} from './message-pipeline-chat.js';
import { type MessagePipelineContext } from './message-pipeline-context.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import type { MemoryManager } from './memory.js';
import {
  consumePendingImages,
  deliverFileDirectives,
  parsePendingImageTtlMs,
  ThinkingMessenger,
  type PendingImageBundle
} from './message-pipeline-helpers.js';
import {
  maybeNotifyQueueAhead,
  runCommandPreflight,
  selectActiveAgent
} from './message-pipeline-preflight.js';
import { createLogger } from './logger.js';
import type { Scheduler } from './scheduler.js';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { TelegramStreamRenderer } from './telegram-stream-renderer.js';
import { randomUUID } from 'crypto';
import type { PromptBuildResult, PromptMode } from './prompt-build.js';
import { recordPromptSessionTrace } from '../services/prompt-session-telemetry.js';
import type { PromptTelemetry } from './message-pipeline-chat.js';
import { parseMemoryIntent } from './memory-intent.js';
import { recordMemoryIntentTrace } from '../services/memory-intent-telemetry.js';
import { emitEvent } from '../services/event-bus.js';

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
  buildPrompt: (
    userMessage: string,
    userId: string,
    mode?: PromptMode
  ) => Promise<string | PromptBuildResult> | string | PromptBuildResult;
  enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void;
  recordRuntimeIssue: (scope: string, error: unknown) => void;
  writeContextSnapshots: () => void;
};

export function createMessagePipeline(options: MessagePipelineOptions) {
  const log = createLogger('message-pipeline');
  const pendingNewSessionUsers = new Set<string>();
  const fullPromptCounterByUser = new Map<string, number>();
  const pendingImageByUser = new Map<string, PendingImageBundle>();
  const pendingImageTtlMs = parsePendingImageTtlMs(process.env.IMAGE_ATTACHMENT_PENDING_TTL_MS);
  const maxSendFileBytes = 45 * 1024 * 1024;
  const summaryFollowupEnabled = parseBool(process.env.SUMMARY_FOLLOWUP_ENABLED, true);
  const telegramStreamingEnabled = parseBool(process.env.TELEGRAM_STREAMING_ENABLED, false);
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
    const requestId = randomUUID();
    let msg = incomingMsg;
    const connector = options.resolveConnector?.(msg) || options.connector;
    const streamResponse =
      (msg.raw as { streamResponse?: (event: AgentEvent) => Promise<void> | void } | undefined)
        ?.streamResponse || null;
    const attachmentCount = msg.attachments?.length || 0;
    log.info('message.received', {
      platform: msg.sender.platform,
      sender: msg.sender.name,
      userId: msg.sender.id,
      requestId,
      attachments: attachmentCount,
      content: msg.content
    });
    emitEvent('request_start', { requestId, userId: msg.sender.id, platform: msg.sender.platform });
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

    const preflight = await runCommandPreflight({
      msg,
      connector,
      commandRouter: options.commandRouter,
      memory: options.memory,
      scheduler: options.scheduler,
      pendingNewSessionUsers,
      writeContextSnapshots: options.writeContextSnapshots
    });
    if (preflight.handled) {
      return;
    }

    const baseContext = preflight.context as Pick<
      MessagePipelineContext,
      'msg' | 'connector' | 'userId' | 'targetChatId' | 'isPassthroughCommand' | 'forceNewSession'
    >;
    const telegramStreamRenderer =
      !streamResponse &&
      telegramStreamingEnabled &&
      msg.sender.platform === 'telegram' &&
      !baseContext.isPassthroughCommand
        ? new TelegramStreamRenderer(connector, targetChatId, { thinkingMessages })
        : null;

    await maybeNotifyQueueAhead(baseContext);

    const { context, useRunnerThisMessage, bucket, isWhitelisted } = selectActiveAgent({
      baseContext,
      userId: msg.sender.id,
      messageId: msg.id,
      useRunnerForChat: options.useRunnerForChat,
      chatRunnerOnlyUsers: options.chatRunnerOnlyUsers,
      chatRunnerPercent: options.chatRunnerPercent,
      chatRunnerAgent: options.chatRunnerAgent,
      userAgent: options.userAgent
    });
    log.info('agent.selected', {
      mode: useRunnerThisMessage ? 'runner' : 'local',
      bucket,
      canaryPercent: options.chatRunnerPercent,
      whitelistMatched: isWhitelisted,
      userId: context.userId
    });

    const thinkingMessenger = new ThinkingMessenger(
      context.connector,
      context.targetChatId,
      thinkingMessages
    );
    if (telegramStreamRenderer) {
      await telegramStreamRenderer.start();
    } else if (!streamResponse) {
      await thinkingMessenger.start();
    }
    let promptLength = 0;
    let promptTelemetry: PromptTelemetry = {
      promptMode: context.isPassthroughCommand ? 'passthrough' : 'compact',
      promptSelectionReason: context.isPassthroughCommand ? 'passthrough-command' : 'not-built-yet',
      memoryContextLength: 0,
      usedMemoryContext: false,
      memoryContextSectionCount: 0
    };

    try {
      await persistUserMessage({
        memory: options.memory,
        context,
        shouldSummarize: options.shouldSummarize
      });

      const { promptForAgent, telemetry } = await preparePromptForAgent({
        context,
        fullPromptEvery,
        fullPromptCounterByUser,
        buildPrompt: options.buildPrompt
      });
      promptLength = promptForAgent.length;
      promptTelemetry = telemetry;

      if (context.isPassthroughCommand) {
        log.info('prompt.passthrough', { userId: context.userId, prompt: promptForAgent });
      } else {
        log.info('prompt.sent', {
          userId: context.userId,
          requestId,
          length: promptForAgent.length,
          mode: telemetry.promptMode,
          reason: telemetry.promptSelectionReason,
          memoryContextLength: telemetry.memoryContextLength,
          memoryContextSectionCount: telemetry.memoryContextSectionCount
        });
      }

      const rawResponse = await executionQueue.enqueue(userId, 'chat', 'high', async () => {
        const eventHandler = async (event: AgentEvent): Promise<void> => {
          if (streamResponse) {
            await streamResponse(event);
          }
          if (telegramStreamRenderer) {
            await telegramStreamRenderer.handleEvent(event);
          }
        };

        if ((streamResponse || telegramStreamRenderer) && context.activeAgent.streamChat) {
          const result = await context.activeAgent.streamChat(
            promptForAgent,
            {
              isPassthroughCommand: context.isPassthroughCommand,
              forceNewSession: context.forceNewSession,
              autoRecoveryNotice: true
            },
            eventHandler
          );
          return result.text;
        }

        return context.activeAgent.chat(promptForAgent, {
          isPassthroughCommand: context.isPassthroughCommand,
          forceNewSession: context.forceNewSession,
          autoRecoveryNotice: true
        });
      });

      const { response, directives } = normalizeAgentResponse(rawResponse);
      const { cleanedResponse, intent: memoryIntent } = parseMemoryIntent(response);

      log.info('response.received', {
        userId: context.userId,
        requestId,
        length: cleanedResponse.length,
        directives: directives.length
      });

      if (memoryIntent) {
        recordMemoryIntentTrace({
          requestId,
          timestamp: Date.now(),
          userId: context.userId,
          channel: context.msg.sender.platform || 'unknown',
          promptMode: promptTelemetry.promptMode,
          intent: memoryIntent
        });
      }

      recordPromptSessionTrace({
        requestId,
        timestamp: now,
        channel: context.msg.sender.platform || 'unknown',
        userId: context.userId,
        executionMode: useRunnerThisMessage ? 'runner' : 'local',
        promptMode: promptTelemetry.promptMode,
        promptSelectionReason: promptTelemetry.promptSelectionReason,
        promptLength,
        memoryContextLength: promptTelemetry.memoryContextLength,
        memoryContextSectionCount: promptTelemetry.memoryContextSectionCount,
        usedMemoryContext: promptTelemetry.usedMemoryContext,
        forceNewSession: context.forceNewSession,
        isPassthroughCommand: context.isPassthroughCommand,
        durationMs: Date.now() - now,
        responseLength: cleanedResponse.length,
        ok: true
      });

      const modelMessageTimestamp = persistModelResponse({
        memory: options.memory,
        context,
        response: cleanedResponse,
        ...(options.enqueueMemoriaSync ? { enqueueMemoriaSync: options.enqueueMemoriaSync } : {})
      });

      if (telegramStreamRenderer) {
        await telegramStreamRenderer.finalize(cleanedResponse);
      } else if (!streamResponse) {
        await thinkingMessenger.stop();
        await thinkingMessenger.deliverFinalResponse(cleanedResponse);
      }

      if (directives.length > 0) {
        await deliverFileDirectives(
          context.connector,
          context.targetChatId,
          directives,
          maxSendFileBytes
        );
      }

      maybeSendSummaryFollowup({
        enabled: summaryFollowupEnabled,
        context,
        response: cleanedResponse,
        minLength: summaryFollowupMinLength,
        maxLength: summaryFollowupMaxLength,
        shouldSummarize: options.shouldSummarize,
        memory: options.memory,
        connectorSendMessage: (text) => context.connector.sendMessage(context.targetChatId, text),
        ...(typeof modelMessageTimestamp === 'number' ? { modelMessageTimestamp } : {})
      });

      emitEvent('request_done', { requestId, userId: msg.sender.id, durationMs: Date.now() - now });
      options.writeContextSnapshots();
    } catch (error) {
      log.error('message.failed', { userId: msg.sender.id, error });
      recordPromptSessionTrace({
        requestId,
        timestamp: now,
        channel: msg.sender.platform || 'unknown',
        userId: msg.sender.id,
        executionMode: useRunnerThisMessage ? 'runner' : 'local',
        promptMode: promptTelemetry.promptMode,
        promptSelectionReason: promptTelemetry.promptSelectionReason,
        promptLength,
        memoryContextLength: promptTelemetry.memoryContextLength,
        memoryContextSectionCount: promptTelemetry.memoryContextSectionCount,
        usedMemoryContext: promptTelemetry.usedMemoryContext,
        forceNewSession: context.forceNewSession,
        isPassthroughCommand: context.isPassthroughCommand,
        durationMs: Date.now() - now,
        ok: false
      });
      emitEvent('request_error', { requestId, userId: msg.sender.id, durationMs: Date.now() - now });
      options.recordRuntimeIssue('message-processing', error);
      options.writeContextSnapshots();
      const errorMsg = 'Sorry, I encountered an error while exercising my powers.';

      if (telegramStreamRenderer) {
        await telegramStreamRenderer.fail(errorMsg);
      } else if (!streamResponse) {
        await thinkingMessenger.stop();
        await thinkingMessenger.deliverFinalResponse(errorMsg);
      }
    }
  };
}
