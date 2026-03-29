import { executionQueue } from './execution-queue.js';
import type { AIAgent } from './agent.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import type { MemoryManager } from './memory.js';
import { inferSummaryMetadata } from './summary-metadata.js';
import { buildAttachmentPrompt } from './message-pipeline-helpers.js';
import type { UnifiedAttachment } from '../types/index.js';

type PreparePromptOptions = {
  msgContent: string;
  userId: string;
  attachments?: UnifiedAttachment[];
  isPassthroughCommand: boolean;
  forceNewSession: boolean;
  fullPromptEvery: number;
  fullPromptCounterByUser: Map<string, number>;
  buildPrompt: (userMessage: string, userId: string, mode?: 'full' | 'compact') => string;
};

type PersistUserMessageOptions = {
  memory: MemoryManager;
  activeAgent: AIAgent;
  userId: string;
  content: string;
  isPassthroughCommand: boolean;
  shouldSummarize: (content: string) => boolean;
};

type PersistModelResponseOptions = {
  memory: MemoryManager;
  enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void;
  userId: string;
  userMessage: string;
  response: string;
  platform: string;
  isPassthroughCommand: boolean;
  forceNewSession: boolean;
};

type FollowupSummaryOptions = {
  enabled: boolean;
  isPassthroughCommand: boolean;
  response: string;
  minLength: number;
  maxLength: number;
  shouldSummarize: (content: string) => boolean;
  memory: MemoryManager;
  activeAgent: AIAgent;
  userId: string;
  modelMessageTimestamp?: number;
  connectorSendMessage: (text: string) => Promise<void>;
};

export async function persistUserMessage(options: PersistUserMessageOptions): Promise<void> {
  let userSummary: string | undefined;

  if (!options.isPassthroughCommand && options.shouldSummarize(options.content)) {
    console.log('📝 [Memory] User input meets summary criteria, generating summary...');
    userSummary = await executionQueue.enqueue(options.userId, 'chat-summary', 'normal', () =>
      options.activeAgent.summarize(options.content)
    );
  }

  options.memory.addMessage(
    options.userId,
    'user',
    options.content,
    inferSummaryMetadata(options.content, userSummary)
  );
}

export function preparePromptForAgent(options: PreparePromptOptions): string {
  let promptForAgent = options.msgContent.trim();

  if (!options.isPassthroughCommand) {
    const currentCounter = options.fullPromptCounterByUser.get(options.userId) || 0;
    const shouldUseFullPrompt =
      options.forceNewSession || currentCounter % options.fullPromptEvery === 0;
    promptForAgent = options.buildPrompt(
      options.msgContent,
      options.userId,
      shouldUseFullPrompt ? 'full' : 'compact'
    );
    options.fullPromptCounterByUser.set(options.userId, currentCounter + 1);
    const attachmentPrompt = buildAttachmentPrompt(options.attachments);
    if (attachmentPrompt) {
      promptForAgent = `${promptForAgent}\n\n${attachmentPrompt}`;
    }
  }

  return promptForAgent;
}

export function persistModelResponse(options: PersistModelResponseOptions): number | undefined {
  if (!options.response || options.response.startsWith('Error')) {
    return undefined;
  }

  const modelMessageTimestamp = options.memory.addMessage(
    options.userId,
    'model',
    options.response
  );

  options.enqueueMemoriaSync?.({
    userId: options.userId,
    userMessage: options.userMessage,
    modelMessage: options.response,
    platform: options.platform,
    isPassthroughCommand: options.isPassthroughCommand,
    forceNewSession: options.forceNewSession
  });

  return modelMessageTimestamp;
}

export function maybeSendSummaryFollowup(options: FollowupSummaryOptions): void {
  const shouldSendSummaryFollowup =
    options.enabled &&
    !options.isPassthroughCommand &&
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
        options.userId,
        'chat-followup-summary',
        'low',
        () => options.activeAgent.summarize(options.response)
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
          options.userId,
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
