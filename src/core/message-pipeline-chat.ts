import { executionQueue } from './execution-queue.js';
import { createLogger } from './logger.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import type { MemoryManager } from './memory.js';
import type { MessagePipelineContext } from './message-pipeline-context.js';
import type { MemoriaRecallMeta, PromptBuildResult, PromptMode } from './prompt-build.js';
import { normalizePromptBuildResult, shouldIncludeMemoryContext } from './prompt-build.js';
import { inferSummaryMetadata } from './summary-metadata.js';
import { buildAttachmentPrompt, extractFileDirectives } from './message-pipeline-helpers.js';

type PreparePromptOptions = {
  context: MessagePipelineContext;
  fullPromptEvery: number;
  fullPromptCounterByUser: Map<string, number>;
  buildPrompt: (
    userMessage: string,
    userId: string,
    mode?: PromptMode
  ) => Promise<string | PromptBuildResult> | string | PromptBuildResult;
};

export type PromptTelemetry = {
  promptMode: PromptMode | 'passthrough';
  promptSelectionReason: string;
  memoryContextLength: number;
  usedMemoryContext: boolean;
  memoryContextSectionCount: number;
};

function isLikelyMinimalFollowup(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 60) {
    return false;
  }
  const newlineCount = (trimmed.match(/\n/g) || []).length;
  if (newlineCount > 1) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  if (
    /^(繼續|然後呢|接著|再來|補充一下|順便|那|所以|另外|然後|再|ok|okay|好|好的|繼續說|詳述一下|展開說明|細講一下)/.test(
      normalized
    )
  ) {
    return true;
  }

  if (/^(how|what|why|and|then|also|so)\b/.test(normalized) && trimmed.length <= 40) {
    return true;
  }

  if (/嗎\??$|呢\??$|吧\??$|？$|\?$/.test(trimmed) && trimmed.length <= 24) {
    return true;
  }

  return false;
}

type PersistUserMessageOptions = {
  memory: MemoryManager;
  context: MessagePipelineContext;
  shouldSummarize: (content: string) => boolean;
};

type PersistModelResponseOptions = {
  memory: MemoryManager;
  enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void;
  context: MessagePipelineContext;
  response: string;
};

type FollowupSummaryOptions = {
  enabled: boolean;
  context: MessagePipelineContext;
  response: string;
  minLength: number;
  maxLength: number;
  shouldSummarize: (content: string) => boolean;
  memory: MemoryManager;
  modelMessageTimestamp?: number;
  connectorSendMessage: (text: string) => Promise<void>;
};

const log = createLogger('message-pipeline.chat');

export function normalizeAgentResponse(rawResponse: string): {
  rawResponse: string;
  response: string;
  directives: ReturnType<typeof extractFileDirectives>['directives'];
} {
  const { cleanedText, directives } = extractFileDirectives(rawResponse);
  return {
    rawResponse,
    response: cleanedText || rawResponse,
    directives
  };
}

export async function persistUserMessage(options: PersistUserMessageOptions): Promise<void> {
  let userSummary: string | undefined;
  const { context } = options;

  if (!context.isPassthroughCommand && options.shouldSummarize(context.msg.content)) {
    log.info('user-summary.requested', {
      userId: context.userId,
      length: context.msg.content.length
    });
    userSummary = await executionQueue.enqueue(context.userId, 'chat-summary', 'normal', () =>
      context.activeAgent.summarize(context.msg.content)
    );
  }

  options.memory.addMessage(
    context.userId,
    'user',
    context.msg.content,
    inferSummaryMetadata(context.msg.content, userSummary)
  );
}

export async function preparePromptForAgent(options: PreparePromptOptions): Promise<{
  promptForAgent: string;
  telemetry: PromptTelemetry;
  memoriaRecall?: MemoriaRecallMeta;
}> {
  const { context } = options;
  let promptForAgent = context.msg.content.trim();
  let memoriaRecall: MemoriaRecallMeta | undefined;
  let telemetry: PromptTelemetry = {
    promptMode: 'passthrough',
    promptSelectionReason: 'passthrough-command',
    memoryContextLength: 0,
    usedMemoryContext: false,
    memoryContextSectionCount: 0
  };

  if (!context.isPassthroughCommand) {
    const currentCounter = options.fullPromptCounterByUser.get(context.userId) || 0;
    const shouldUseFullPrompt =
      context.forceNewSession || currentCounter % options.fullPromptEvery === 0;
    const shouldUseMinimal =
      !shouldUseFullPrompt &&
      currentCounter > 0 &&
      !context.msg.attachments?.length &&
      !shouldIncludeMemoryContext('compact', context.msg.content) &&
      isLikelyMinimalFollowup(context.msg.content);
    const promptMode: PromptMode = shouldUseFullPrompt
      ? 'full'
      : shouldUseMinimal
        ? 'minimal'
        : 'compact';
    const promptResult = normalizePromptBuildResult(
      await options.buildPrompt(context.msg.content, context.userId, promptMode),
      promptMode
    );
    promptForAgent = promptResult.prompt;
    memoriaRecall = promptResult.memoriaRecall;
    telemetry = {
      promptMode: promptResult.mode,
      promptSelectionReason: context.forceNewSession
        ? 'force-new-session'
        : promptMode === 'full'
          ? 'periodic-full'
          : promptMode === 'minimal'
            ? 'minimal-followup'
            : 'compact-followup',
      memoryContextLength: promptResult.memoryContextLength,
      usedMemoryContext: promptResult.usedMemoryContext,
      memoryContextSectionCount: promptResult.memoryContextSectionCount
    };
    options.fullPromptCounterByUser.set(context.userId, currentCounter + 1);
    const attachmentPrompt = buildAttachmentPrompt(context.msg.attachments);
    if (attachmentPrompt) {
      promptForAgent = `${promptForAgent}\n\n${attachmentPrompt}`;
    }
  }

  return { promptForAgent, telemetry, ...(memoriaRecall ? { memoriaRecall } : {}) };
}

export function persistModelResponse(options: PersistModelResponseOptions): number | undefined {
  const { context } = options;
  if (!options.response || options.response.startsWith('Error')) {
    return undefined;
  }

  const modelMessageTimestamp = options.memory.addMessage(
    context.userId,
    'model',
    options.response
  );

  options.enqueueMemoriaSync?.({
    userId: context.userId,
    userMessage: context.msg.content,
    modelMessage: options.response,
    platform: context.msg.sender.platform,
    isPassthroughCommand: context.isPassthroughCommand,
    forceNewSession: context.forceNewSession
  });

  return modelMessageTimestamp;
}

export function maybeSendSummaryFollowup(options: FollowupSummaryOptions): void {
  const { context } = options;
  const shouldSendSummaryFollowup =
    options.enabled &&
    !context.isPassthroughCommand &&
    options.response.length >= options.minLength &&
    options.shouldSummarize(options.response) &&
    !options.response.startsWith('Error');

  if (!shouldSendSummaryFollowup) {
    return;
  }

  void (async () => {
    try {
      log.info('followup-summary.requested', {
        userId: context.userId,
        responseLength: options.response.length
      });
      const summary = await executionQueue.enqueue(
        context.userId,
        'chat-followup-summary',
        'low',
        () => context.activeAgent.summarize(options.response)
      );
      const normalized = summary.trim();
      if (!normalized) {
        return;
      }
      const brief =
        normalized.length > options.maxLength
          ? normalized.slice(0, options.maxLength - 3) + '...'
          : normalized;
      if (typeof options.modelMessageTimestamp === 'number') {
        options.memory.updateMessageMetadata(
          context.userId,
          'model',
          options.modelMessageTimestamp,
          inferSummaryMetadata(options.response, normalized)
        );
      }
      await options.connectorSendMessage(`📝 補充摘要\n${brief}`);
    } catch (error) {
      log.warn('followup-summary.failed', { userId: context.userId, error });
    }
  })();
}
