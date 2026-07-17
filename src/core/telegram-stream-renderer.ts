import type { Connector } from '../types/index.js';
import type { AgentEvent } from './agent-result.js';
import { createLogger } from './logger.js';
import { parsePositiveInt } from '../utils/env.js';

const log = createLogger('telegram-stream');

const DEFAULT_EDIT_THROTTLE_MS = 1000;
const DEFAULT_MIN_DELTA_CHARS = 40;
const DEFAULT_FORCE_FLUSH_MS = 2500;
const STATUS_MIN_INTERVAL_MS = 600;
const DEFAULT_EARLY_FLUSH_CHARS = 120;
const DEFAULT_MAX_EDIT_FAILURES = 3;
const MAX_SINGLE_MESSAGE_LENGTH = 3900;
const MAX_PROGRESS_TEXT_LENGTH = 3900;
const DEFAULT_REASONING_THROTTLE_MS = 1500;
const REASONING_DISPLAY_MAX_CHARS = 3500;
const DEFAULT_DRAFT_REFRESH_MS = 20000;
const DEFAULT_TYPING_REFRESH_MS = 4000;
const STATUS_HISTORY_LIMIT = 2;
const REASONING_PREFIX = '💭 思考中…';

type NativeDraftOptions = {
  draftId: number;
  messageThreadId?: number;
};

type TelegramStreamRendererOptions = {
  editThrottleMs?: number;
  minDeltaChars?: number;
  forceFlushMs?: number;
  earlyFlushChars?: number;
  maxEditFailures?: number;
  thinkingMessages?: string[];
  thinkingRotateMs?: number;
  reasoningMode?: boolean;
  reasoningThrottleMs?: number;
  finalizeAsNewMessage?: boolean;
  nativeDraft?: NativeDraftOptions;
  messageThreadId?: number;
  draftRefreshMs?: number;
  typingRefreshMs?: number;
};

type ProgressDisplay =
  | { kind: 'idle' }
  | { kind: 'draft'; draftId: number }
  | { kind: 'message'; messageId: string }
  | { kind: 'unavailable' };

type RendererLifecycle = 'active' | 'finalizing' | 'completed' | 'failed';

const DEFAULT_THINKING_ROTATE_MS = 3000;

function takeUtf16Tail(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  let start = text.length - maxLength;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) {
    start += 1;
  }
  return text.slice(start);
}

function isToolStatus(text: string): boolean {
  return /^(?:🔍|📁|📖|💻|🧩|✏️|🌐|⚙️)/u.test(text);
}

export class TelegramStreamRenderer {
  private display: ProgressDisplay = { kind: 'idle' };
  private lifecycle: RendererLifecycle = 'active';
  private buffer = '';
  private lastRenderedBufferLength = 0;
  private lastRenderAt = 0;
  private lastRenderedText = '';
  private latestErrorMessage = '';
  private finalEventText = '';
  private sawDelta = false;
  private streamingDisabled = false;
  private flushInterval: NodeJS.Timeout | null = null;
  private updateChain: Promise<void> = Promise.resolve();
  private consecutiveEditFailures = 0;
  private thinkingRotateInterval: NodeJS.Timeout | null = null;
  private thinkingIndex = 0;
  private reasoningBuffer = '';
  private reasoningTruncated = false;
  private sawReasoning = false;
  private reasoningRenderedOnce = false;
  private lastReasoningRenderAt = 0;
  private statusHistory: string[] = [];
  private draftRefreshInterval: NodeJS.Timeout | null = null;
  private typingRefreshInterval: NodeJS.Timeout | null = null;

  private readonly editThrottleMs: number;
  private readonly minDeltaChars: number;
  private readonly forceFlushMs: number;
  private readonly earlyFlushChars: number;
  private readonly maxEditFailures: number;
  private readonly thinkingMessages: string[];
  private readonly thinkingRotateMs: number;
  private readonly reasoningMode: boolean;
  private readonly reasoningThrottleMs: number;
  private readonly finalizeAsNewMessage: boolean;
  private readonly nativeDraft: NativeDraftOptions | undefined;
  private readonly messageThreadId: number | undefined;
  private readonly draftRefreshMs: number;
  private readonly typingRefreshMs: number;

  constructor(
    private readonly connector: Connector,
    private readonly chatId: string,
    options: TelegramStreamRendererOptions = {}
  ) {
    this.editThrottleMs =
      options.editThrottleMs ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_EDIT_THROTTLE_MS, DEFAULT_EDIT_THROTTLE_MS);
    this.minDeltaChars =
      options.minDeltaChars ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_MIN_DELTA_CHARS, DEFAULT_MIN_DELTA_CHARS);
    this.forceFlushMs =
      options.forceFlushMs ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_FORCE_FLUSH_MS, DEFAULT_FORCE_FLUSH_MS);
    this.earlyFlushChars =
      options.earlyFlushChars ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_EARLY_FLUSH_CHARS, DEFAULT_EARLY_FLUSH_CHARS);
    this.maxEditFailures =
      options.maxEditFailures ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_MAX_EDIT_FAILURES, DEFAULT_MAX_EDIT_FAILURES);
    this.thinkingMessages =
      options.thinkingMessages && options.thinkingMessages.length > 0
        ? options.thinkingMessages
        : ['🤔 思考中...'];
    this.thinkingRotateMs =
      options.thinkingRotateMs ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_THINKING_ROTATE_MS, DEFAULT_THINKING_ROTATE_MS);
    this.reasoningMode =
      options.reasoningMode ??
      (process.env.TELEGRAM_STREAM_REASONING_MODE ?? 'true').trim().toLowerCase() !== 'false';
    this.reasoningThrottleMs =
      options.reasoningThrottleMs ??
      parsePositiveInt(
        process.env.TELEGRAM_STREAM_REASONING_THROTTLE_MS,
        DEFAULT_REASONING_THROTTLE_MS
      );
    this.finalizeAsNewMessage =
      options.finalizeAsNewMessage ??
      (process.env.TELEGRAM_STREAM_FINALIZE_NEW_MESSAGE !== undefined
        ? process.env.TELEGRAM_STREAM_FINALIZE_NEW_MESSAGE.trim().toLowerCase() !== 'false'
        : this.reasoningMode);
    this.nativeDraft = options.nativeDraft;
    this.messageThreadId = options.nativeDraft?.messageThreadId ?? options.messageThreadId;
    this.draftRefreshMs =
      options.draftRefreshMs ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_DRAFT_REFRESH_MS, DEFAULT_DRAFT_REFRESH_MS);
    this.typingRefreshMs =
      options.typingRefreshMs ??
      parsePositiveInt(process.env.TELEGRAM_STREAM_TYPING_REFRESH_MS, DEFAULT_TYPING_REFRESH_MS);
  }

  async start(): Promise<void> {
    if (this.display.kind !== 'idle') {
      return;
    }

    const firstThinking = this.clampProgressText(this.thinkingMessages[0]!);
    await this.startProgressDisplay(firstThinking);
    this.lastRenderedText = firstThinking;
    this.lastRenderAt = Date.now();
    const displayKind = (this.display as ProgressDisplay).kind;

    log.info('stream.started', {
      chatId: this.chatId,
      display: this.display.kind,
      editThrottleMs: this.editThrottleMs,
      minDeltaChars: this.minDeltaChars,
      forceFlushMs: this.forceFlushMs,
      earlyFlushChars: this.earlyFlushChars,
      maxEditFailures: this.maxEditFailures
    });

    if (displayKind !== 'unavailable') {
      this.flushInterval = setInterval(() => {
        void this.maybeFlush(false);
      }, 250);
      this.flushInterval.unref?.();

      if (this.thinkingMessages.length > 1) {
        this.thinkingRotateInterval = setInterval(() => {
          void this.rotateThinkingMessage();
        }, this.thinkingRotateMs);
        this.thinkingRotateInterval.unref?.();
      }

      if (displayKind === 'draft' && this.draftRefreshMs > 0) {
        this.draftRefreshInterval = setInterval(() => {
          void this.refreshDraft();
        }, this.draftRefreshMs);
        this.draftRefreshInterval.unref?.();
      }
    }

    if (this.connector.sendChatAction && this.typingRefreshMs > 0) {
      void this.sendTyping();
      this.typingRefreshInterval = setInterval(() => {
        void this.sendTyping();
      }, this.typingRefreshMs);
      this.typingRefreshInterval.unref?.();
    }
  }

  private async startProgressDisplay(text: string): Promise<void> {
    if (this.nativeDraft && this.connector.sendMessageDraft) {
      try {
        await this.connector.sendMessageDraft(this.chatId, this.nativeDraft.draftId, text, {
          ...(this.messageThreadId !== undefined ? { messageThreadId: this.messageThreadId } : {}),
          retries: 0
        });
        this.display = { kind: 'draft', draftId: this.nativeDraft.draftId };
        return;
      } catch (error) {
        log.warn('draft.start-failed', {
          chatId: this.chatId,
          draftId: this.nativeDraft.draftId,
          error
        });
      }
    }

    const messageId = await this.connector.sendPlaceholder(this.chatId, text, {
      ...(this.messageThreadId !== undefined ? { messageThreadId: this.messageThreadId } : {})
    });
    this.display = messageId ? { kind: 'message', messageId } : { kind: 'unavailable' };
  }

  private async transitionDraftToFallback(text: string, error: unknown): Promise<void> {
    this.stopDraftRefreshInterval();
    log.warn('draft.update-failed-fallback', {
      chatId: this.chatId,
      error
    });
    const messageId = await this.connector.sendPlaceholder(this.chatId, text, {
      ...(this.messageThreadId !== undefined ? { messageThreadId: this.messageThreadId } : {})
    });
    if (!messageId) {
      this.display = { kind: 'unavailable' };
      this.streamingDisabled = true;
      throw error;
    }
    this.display = { kind: 'message', messageId };
    this.consecutiveEditFailures = 0;
  }

  private updateProgressDisplay(text: string): Promise<void> {
    const nextText = this.clampProgressText(text);
    const task = this.updateChain
      .catch(() => undefined)
      .then(async () => {
        if (this.lifecycle !== 'active' || this.display.kind === 'unavailable') {
          return;
        }

        if (this.display.kind === 'draft') {
          try {
            await this.connector.sendMessageDraft?.(this.chatId, this.display.draftId, nextText, {
              ...(this.messageThreadId !== undefined
                ? { messageThreadId: this.messageThreadId }
                : {}),
              retries: 0
            });
          } catch (error) {
            await this.transitionDraftToFallback(nextText, error);
          }
          this.lastRenderedText = nextText;
          this.lastRenderAt = Date.now();
          return;
        }

        if (this.display.kind === 'message') {
          try {
            await this.connector.editMessage(this.chatId, this.display.messageId, nextText, {
              retries: 0,
              suppressFallbackSend: true,
              formatMode: 'plain',
              throwOnError: true
            });
            this.lastRenderedText = nextText;
            this.lastRenderAt = Date.now();
            this.consecutiveEditFailures = 0;
          } catch (error) {
            this.consecutiveEditFailures += 1;
            if (this.consecutiveEditFailures >= this.maxEditFailures) {
              this.streamingDisabled = true;
              log.warn('stream.disabled-after-edit-failures', {
                chatId: this.chatId,
                consecutiveEditFailures: this.consecutiveEditFailures
              });
            }
            throw error;
          }
        }
      });
    this.updateChain = task;
    return task;
  }

  private async rotateThinkingMessage(): Promise<void> {
    if (
      this.sawReasoning ||
      (!this.reasoningMode && this.sawDelta) ||
      this.lifecycle !== 'active' ||
      this.streamingDisabled ||
      this.display.kind === 'unavailable'
    ) {
      this.stopThinkingRotateInterval();
      return;
    }

    this.thinkingIndex = (this.thinkingIndex + 1) % this.thinkingMessages.length;
    const nextText = this.thinkingMessages[this.thinkingIndex]!;
    if (nextText === this.lastRenderedText) {
      return;
    }

    try {
      await this.updateProgressDisplay(nextText);
    } catch (error) {
      log.warn('thinking.rotate-failed', { chatId: this.chatId, error });
    }
  }

  private stopThinkingRotateInterval(): void {
    if (this.thinkingRotateInterval) {
      clearInterval(this.thinkingRotateInterval);
      this.thinkingRotateInterval = null;
    }
  }

  private stopDraftRefreshInterval(): void {
    if (this.draftRefreshInterval) {
      clearInterval(this.draftRefreshInterval);
      this.draftRefreshInterval = null;
    }
  }

  private appendReasoning(chunk: string): void {
    const combined = this.reasoningBuffer + chunk;
    if (combined.length > REASONING_DISPLAY_MAX_CHARS) {
      this.reasoningTruncated = true;
      this.reasoningBuffer = takeUtf16Tail(combined, REASONING_DISPLAY_MAX_CHARS);
      return;
    }
    this.reasoningBuffer = combined;
  }

  private rememberStatus(text: string): void {
    const previous = this.statusHistory[this.statusHistory.length - 1];
    if (previous === text) {
      return;
    }
    this.statusHistory.push(text);
    if (this.statusHistory.length > STATUS_HISTORY_LIMIT) {
      this.statusHistory.splice(0, this.statusHistory.length - STATUS_HISTORY_LIMIT);
    }
  }

  private formatProgressText(): string {
    const blocks = [this.thinkingMessages[0]!];
    const reasoning = this.reasoningBuffer.trim();
    if (reasoning) {
      const prefix = this.reasoningTruncated ? '…' : '';
      blocks.push(`${REASONING_PREFIX}\n${prefix}${reasoning}`);
    }
    for (const status of this.statusHistory) {
      blocks.push(`▸ ${status}`);
    }
    return this.clampProgressText(blocks.join('\n\n'));
  }

  private clampProgressText(text: string): string {
    if (text.length <= MAX_PROGRESS_TEXT_LENGTH) {
      return text;
    }
    const firstBreak = text.indexOf('\n');
    const header = firstBreak >= 0 ? text.slice(0, firstBreak) : this.thinkingMessages[0]!;
    const tailBudget = Math.max(0, MAX_PROGRESS_TEXT_LENGTH - header.length - 2);
    return `${header}\n…${takeUtf16Tail(text, tailBudget)}`;
  }

  private async renderReasoning(chunk: string): Promise<void> {
    this.appendReasoning(chunk);
    this.sawReasoning = true;
    this.stopThinkingRotateInterval();

    if (
      this.lifecycle !== 'active' ||
      this.streamingDisabled ||
      this.display.kind === 'unavailable'
    ) {
      return;
    }

    const now = Date.now();
    const due =
      !this.reasoningRenderedOnce || now - this.lastReasoningRenderAt >= this.reasoningThrottleMs;
    if (!due) {
      return;
    }

    const nextText = this.formatProgressText();
    if (nextText === this.lastRenderedText) {
      return;
    }

    try {
      await this.updateProgressDisplay(nextText);
      this.reasoningRenderedOnce = true;
      this.lastReasoningRenderAt = Date.now();
    } catch (error) {
      log.warn('reasoning.update-failed', { chatId: this.chatId, error });
    }
  }

  private async renderStatus(text: string): Promise<void> {
    const statusText = text.trim();
    if (!statusText) {
      return;
    }
    this.rememberStatus(statusText);

    if (
      this.lifecycle !== 'active' ||
      this.streamingDisabled ||
      this.display.kind === 'unavailable' ||
      (!this.reasoningMode && this.sawDelta)
    ) {
      return;
    }

    const now = Date.now();
    if (!isToolStatus(statusText) && now - this.lastRenderAt < STATUS_MIN_INTERVAL_MS) {
      return;
    }

    this.stopThinkingRotateInterval();
    const nextText = this.formatProgressText();
    if (nextText === this.lastRenderedText) {
      return;
    }

    try {
      await this.updateProgressDisplay(nextText);
    } catch (error) {
      log.warn('status.update-failed', { chatId: this.chatId, error });
    }
  }

  async handleEvent(event: AgentEvent): Promise<void> {
    if (this.lifecycle !== 'active') {
      return;
    }

    if (event.type === 'reasoning') {
      await this.renderReasoning(event.text);
      return;
    }

    if (event.type === 'status') {
      await this.renderStatus(event.text);
      return;
    }

    if (event.type === 'delta') {
      const isFirstDelta = !this.sawDelta;
      this.sawDelta = true;
      this.buffer += event.text;
      if (this.reasoningMode) {
        return;
      }
      if (isFirstDelta) {
        this.stopThinkingRotateInterval();
        log.info('stream.first-delta', {
          chatId: this.chatId,
          chunkLength: event.text.length,
          bufferLength: this.buffer.length
        });
      }
      await this.maybeFlush(this.lastRenderedBufferLength === 0);
      return;
    }

    if (event.type === 'done') {
      this.finalEventText = event.text;
      return;
    }

    if (event.type === 'error') {
      this.latestErrorMessage = event.message;
    }
  }

  async finalize(finalText: string): Promise<void> {
    if (this.lifecycle !== 'active') {
      return;
    }
    this.lifecycle = 'finalizing';
    this.stopTimers();
    await this.awaitUpdate();

    const resolvedText = finalText.trim() || this.finalEventText.trim() || this.buffer.trim();
    if (!resolvedText) {
      await this.clearProgressDisplay('✅ 已完成');
      this.lifecycle = 'completed';
      log.info('stream.finalize-empty', { chatId: this.chatId });
      return;
    }

    log.info('stream.finalizing', {
      chatId: this.chatId,
      display: this.display.kind,
      textLength: resolvedText.length,
      sawDelta: this.sawDelta,
      streamingDisabled: this.streamingDisabled
    });

    try {
      const canEditInPlace =
        !this.finalizeAsNewMessage &&
        this.display.kind === 'message' &&
        resolvedText.length <= MAX_SINGLE_MESSAGE_LENGTH;

      if (canEditInPlace && this.display.kind === 'message') {
        await this.connector.editMessage(this.chatId, this.display.messageId, resolvedText, {
          retries: 0,
          suppressFallbackSend: true,
          formatMode: 'markdown-v2',
          throwOnError: true
        });
        this.display = { kind: 'unavailable' };
        this.lifecycle = 'completed';
        log.info('stream.finalized-via-edit', {
          chatId: this.chatId,
          textLength: resolvedText.length
        });
        return;
      }

      await this.connector.sendMessage(this.chatId, resolvedText, {
        retries: 2,
        throwOnError: true,
        retryOnTimeout: false,
        parseMode: 'markdown-v2',
        ...(this.messageThreadId !== undefined ? { messageThreadId: this.messageThreadId } : {})
      });
      await this.clearProgressDisplay('✅ 已完成');
      this.lifecycle = 'completed';
      log.info('stream.finalized-via-new-message', {
        chatId: this.chatId,
        textLength: resolvedText.length
      });
    } catch (error) {
      this.lifecycle = 'active';
      log.warn('stream.finalize-failed', { chatId: this.chatId, error });
      throw error;
    }
  }

  async fail(message: string): Promise<void> {
    if (this.lifecycle === 'completed' || this.lifecycle === 'failed') {
      return;
    }
    this.lifecycle = 'finalizing';
    this.stopTimers();
    await this.awaitUpdate();

    const fallback = message.trim() || this.latestErrorMessage.trim() || '⚠️ 生成中斷';
    log.warn('stream.failed', {
      chatId: this.chatId,
      display: this.display.kind,
      fallbackLength: fallback.length,
      sawDelta: this.sawDelta,
      streamingDisabled: this.streamingDisabled
    });

    try {
      await this.connector.sendMessage(this.chatId, fallback, {
        retries: 1,
        throwOnError: true,
        retryOnTimeout: false,
        ...(this.messageThreadId !== undefined ? { messageThreadId: this.messageThreadId } : {})
      });
      await this.clearProgressDisplay('⚠️ 已中斷');
    } catch (error) {
      log.warn('failure.send-failed', { chatId: this.chatId, error });
      try {
        if (this.display.kind === 'message') {
          await this.connector.editMessage(this.chatId, this.display.messageId, fallback, {
            retries: 0,
            suppressFallbackSend: true,
            formatMode: 'plain'
          });
        } else if (this.display.kind === 'draft' && this.connector.sendMessageDraft) {
          await this.connector.sendMessageDraft(
            this.chatId,
            this.display.draftId,
            this.clampProgressText(fallback),
            {
              ...(this.messageThreadId !== undefined
                ? { messageThreadId: this.messageThreadId }
                : {}),
              retries: 0
            }
          );
        }
      } catch (updateError) {
        log.warn('failure.progress-update-failed', {
          chatId: this.chatId,
          error: updateError
        });
      }
    }
    this.lifecycle = 'failed';
  }

  private async clearProgressDisplay(marker: string): Promise<void> {
    const display = this.display;
    this.display = { kind: 'unavailable' };
    if (display.kind !== 'message') {
      return;
    }

    if (this.connector.deleteMessage) {
      try {
        await this.connector.deleteMessage(this.chatId, display.messageId);
        return;
      } catch (error) {
        log.warn('progress.delete-failed', { chatId: this.chatId, error });
      }
    }

    try {
      await this.connector.editMessage(this.chatId, display.messageId, marker, {
        retries: 0,
        suppressFallbackSend: true,
        formatMode: 'plain'
      });
    } catch (error) {
      log.warn('progress.marker-update-failed', { chatId: this.chatId, error });
    }
  }

  private stopTimers(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.stopThinkingRotateInterval();
    this.stopDraftRefreshInterval();
    if (this.typingRefreshInterval) {
      clearInterval(this.typingRefreshInterval);
      this.typingRefreshInterval = null;
    }
  }

  private async awaitUpdate(): Promise<void> {
    try {
      await this.updateChain;
    } catch {
      // Progress display is best-effort; final delivery still proceeds.
    }
  }

  private async refreshDraft(): Promise<void> {
    if (this.lifecycle !== 'active' || this.display.kind !== 'draft' || !this.lastRenderedText) {
      return;
    }
    try {
      await this.updateProgressDisplay(this.lastRenderedText);
    } catch (error) {
      log.warn('draft.refresh-failed', { chatId: this.chatId, error });
    }
  }

  private async sendTyping(): Promise<void> {
    if (!this.connector.sendChatAction || this.lifecycle !== 'active') {
      return;
    }
    try {
      await this.connector.sendChatAction(this.chatId, 'typing', {
        ...(this.messageThreadId !== undefined ? { messageThreadId: this.messageThreadId } : {})
      });
    } catch (error) {
      log.warn('typing.update-failed', { chatId: this.chatId, error });
    }
  }

  private buildStreamingText(): string {
    if (!this.sawDelta) {
      return this.thinkingMessages[0]!;
    }
    return this.clampProgressText(`✍️ 回覆中...\n\n${this.buffer}`.trimEnd());
  }

  private async maybeFlush(force: boolean): Promise<void> {
    if (
      this.reasoningMode ||
      this.streamingDisabled ||
      this.lifecycle !== 'active' ||
      this.display.kind === 'unavailable' ||
      !this.sawDelta
    ) {
      return;
    }

    const now = Date.now();
    const deltaChars = this.buffer.length - this.lastRenderedBufferLength;
    const elapsedMs = now - this.lastRenderAt;
    const shouldFlush =
      force ||
      deltaChars >= this.earlyFlushChars ||
      (elapsedMs >= this.editThrottleMs && deltaChars >= this.minDeltaChars) ||
      elapsedMs >= this.forceFlushMs;

    if (!shouldFlush) {
      return;
    }

    const nextText = this.buildStreamingText();
    if (nextText === this.lastRenderedText) {
      return;
    }

    log.info('stream.flush', {
      chatId: this.chatId,
      force,
      deltaChars,
      elapsedMs,
      bufferLength: this.buffer.length,
      previewLength: nextText.length,
      consecutiveEditFailures: this.consecutiveEditFailures
    });

    try {
      await this.updateProgressDisplay(nextText);
      this.lastRenderedBufferLength = this.buffer.length;
    } catch (error) {
      log.warn('stream.edit-failed', {
        chatId: this.chatId,
        consecutiveEditFailures: this.consecutiveEditFailures,
        error
      });
    }
  }
}
