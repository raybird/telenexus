import { executionQueue } from './execution-queue.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import type { MemoryManager } from './memory.js';
import type { MessagePipelineContext } from './message-pipeline-context.js';
import { inferSummaryMetadata } from './summary-metadata.js';
import { buildAttachmentPrompt, extractFileDirectives } from './message-pipeline-helpers.js';

type PreparePromptOptions = {
  context: MessagePipelineContext;
  fullPromptEvery: number;
  fullPromptCounterByUser: Map<string, number>;
  buildPrompt: (userMessage: string, userId: string, mode?: 'full' | 'compact') => string;
};

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
    console.log('📝 [Memory] User input meets summary criteria, generating summary...');
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

export function preparePromptForAgent(options: PreparePromptOptions): string {
  const { context } = options;
  let promptForAgent = context.msg.content.trim();

  if (!context.isPassthroughCommand) {
    const currentCounter = options.fullPromptCounterByUser.get(context.userId) || 0;
    const shouldUseFullPrompt =
      context.forceNewSession || currentCounter % options.fullPromptEvery === 0;
    promptForAgent = options.buildPrompt(
      context.msg.content,
      context.userId,
      shouldUseFullPrompt ? 'full' : 'compact'
    );
    options.fullPromptCounterByUser.set(context.userId, currentCounter + 1);
    const attachmentPrompt = buildAttachmentPrompt(context.msg.attachments);
    if (attachmentPrompt) {
      promptForAgent = `${promptForAgent}\n\n${attachmentPrompt}`;
    }
  }

  return promptForAgent;
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
      console.log('📝 [Followup] Generating post-reply summary...');
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
      console.warn('📝 [Followup] Summary generation failed:', error);
    }
  })();
}
