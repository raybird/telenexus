import type { Connector, UnifiedMessage } from '../types/index.js';
import type { AIAgent } from './agent.js';
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
    console.log(
      `[System] Message execution mode: ${useRunnerThisMessage ? 'runner' : 'local'} (bucket=${bucket}, canary=${options.chatRunnerPercent}%, whitelist=${isWhitelisted})`
    );

    const thinkingMessenger = new ThinkingMessenger(
      context.connector,
      context.targetChatId,
      thinkingMessages
    );
    await thinkingMessenger.start();

    try {
      await persistUserMessage({
        memory: options.memory,
        context,
        shouldSummarize: options.shouldSummarize
      });

      const promptForAgent = preparePromptForAgent({
        context,
        fullPromptEvery,
        fullPromptCounterByUser,
        buildPrompt: options.buildPrompt
      });

      if (context.isPassthroughCommand) {
        console.log(`📤 [System] Passthrough command -> CLI: ${promptForAgent}`);
      } else {
        console.log(`📤 [System] Sending prompt to AI (length: ${promptForAgent.length} chars)`);
      }

      const rawResponse = await executionQueue.enqueue(userId, 'chat', 'high', () =>
        context.activeAgent.chat(promptForAgent, {
          isPassthroughCommand: context.isPassthroughCommand,
          forceNewSession: context.forceNewSession,
          autoRecoveryNotice: true
        })
      );

      const { response, directives } = normalizeAgentResponse(rawResponse);

      console.log(`📥 [AI] Reply length: ${response.length}`);

      const modelMessageTimestamp = persistModelResponse({
        memory: options.memory,
        context,
        response,
        ...(options.enqueueMemoriaSync ? { enqueueMemoriaSync: options.enqueueMemoriaSync } : {})
      });

      await thinkingMessenger.stop();
      await thinkingMessenger.deliverFinalResponse(response);

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
        response,
        minLength: summaryFollowupMinLength,
        maxLength: summaryFollowupMaxLength,
        shouldSummarize: options.shouldSummarize,
        memory: options.memory,
        connectorSendMessage: (text) => context.connector.sendMessage(context.targetChatId, text),
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
