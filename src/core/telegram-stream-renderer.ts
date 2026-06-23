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
const DEFAULT_REASONING_THROTTLE_MS = 1500;
const REASONING_DISPLAY_MAX_CHARS = 3500;
const REASONING_PREFIX = '💭 思考中…';

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
};

const DEFAULT_THINKING_ROTATE_MS = 3000;

export class TelegramStreamRenderer {
  private placeholderMsgId = '';
  private placeholderSent = false;
  private buffer = '';
  private lastRenderedBufferLength = 0;
  private lastRenderAt = 0;
  private lastRenderedText = '';
  private latestErrorMessage = '';
  private finalEventText = '';
  private sawDelta = false;
  private streamingDisabled = false;
  private completed = false;
  private flushInterval: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;
  private consecutiveEditFailures = 0;
  private thinkingRotateInterval: NodeJS.Timeout | null = null;
  private thinkingIndex = 0;
  private thinkingUpdateInFlight: Promise<void> | null = null;
  private reasoningBuffer = '';
  private sawReasoning = false;
  private reasoningRenderedOnce = false;
  private lastReasoningRenderAt = 0;

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
    // 完成時刪除占位訊息、改發新訊息（讓最終訊息帶完成時間戳）；
    // 預設跟隨 reasoningMode，可用環境變數獨立覆寫
    this.finalizeAsNewMessage =
      options.finalizeAsNewMessage ??
      (process.env.TELEGRAM_STREAM_FINALIZE_NEW_MESSAGE !== undefined
        ? process.env.TELEGRAM_STREAM_FINALIZE_NEW_MESSAGE.trim().toLowerCase() !== 'false'
        : this.reasoningMode);
  }

  async start(): Promise<void> {
    if (this.placeholderSent) {
      return;
    }
    const firstThinking = this.thinkingMessages[0]!;
    this.placeholderMsgId = await this.connector.sendPlaceholder(this.chatId, firstThinking);
    this.placeholderSent = this.placeholderMsgId.length > 0;
    this.lastRenderedText = firstThinking;
    this.lastRenderAt = Date.now();
    log.info('stream.started', {
      chatId: this.chatId,
      placeholderSent: this.placeholderSent,
      editThrottleMs: this.editThrottleMs,
      minDeltaChars: this.minDeltaChars,
      forceFlushMs: this.forceFlushMs,
      earlyFlushChars: this.earlyFlushChars,
      maxEditFailures: this.maxEditFailures
    });

    if (this.placeholderSent) {
      this.flushInterval = setInterval(() => {
        void this.maybeFlush(false);
      }, 250);
      if (this.thinkingMessages.length > 1) {
        this.thinkingRotateInterval = setInterval(() => {
          void this.rotateThinkingMessage();
        }, this.thinkingRotateMs);
      }
    }
  }

  private async rotateThinkingMessage(): Promise<void> {
    if (
      this.sawReasoning ||
      (!this.reasoningMode && this.sawDelta) ||
      this.completed ||
      this.streamingDisabled ||
      !this.placeholderSent ||
      !this.placeholderMsgId ||
      this.thinkingUpdateInFlight
    ) {
      this.stopThinkingRotateInterval();
      return;
    }

    this.thinkingIndex = (this.thinkingIndex + 1) % this.thinkingMessages.length;
    const nextText = this.thinkingMessages[this.thinkingIndex]!;
    if (nextText === this.lastRenderedText) {
      return;
    }

    this.thinkingUpdateInFlight = this.connector
      .editMessage(this.chatId, this.placeholderMsgId, nextText, {
        retries: 0,
        suppressFallbackSend: true
      })
      .then(() => {
        this.lastRenderedText = nextText;
        this.lastRenderAt = Date.now();
        this.consecutiveEditFailures = 0;
      })
      .catch((error) => {
        this.consecutiveEditFailures += 1;
        log.warn('thinking.rotate-failed', {
          chatId: this.chatId,
          consecutiveEditFailures: this.consecutiveEditFailures,
          error
        });
        if (this.consecutiveEditFailures >= this.maxEditFailures) {
          this.streamingDisabled = true;
          this.stopThinkingRotateInterval();
          log.warn('thinking.rotate-disabled-after-failures', { chatId: this.chatId });
        }
      })
      .finally(() => {
        this.thinkingUpdateInFlight = null;
      });

    await this.thinkingUpdateInFlight;
  }

  private stopThinkingRotateInterval(): void {
    if (this.thinkingRotateInterval) {
      clearInterval(this.thinkingRotateInterval);
      this.thinkingRotateInterval = null;
    }
  }

  private formatReasoning(): string {
    const trimmed = this.reasoningBuffer.trim();
    if (!trimmed) {
      return this.thinkingMessages[0]!;
    }
    const tail =
      trimmed.length > REASONING_DISPLAY_MAX_CHARS
        ? `…${trimmed.slice(trimmed.length - REASONING_DISPLAY_MAX_CHARS)}`
        : trimmed;
    return `${REASONING_PREFIX}\n\n${tail}`;
  }

  private async renderReasoning(chunk: string): Promise<void> {
    this.reasoningBuffer += chunk;
    this.sawReasoning = true;
    // reasoning 接手後停止罐頭思考語輪播，改顯示真實思考內容
    this.stopThinkingRotateInterval();

    if (
      this.completed ||
      this.streamingDisabled ||
      !this.placeholderSent ||
      !this.placeholderMsgId ||
      this.thinkingUpdateInFlight
    ) {
      return;
    }

    const now = Date.now();
    const due =
      !this.reasoningRenderedOnce || now - this.lastReasoningRenderAt >= this.reasoningThrottleMs;
    if (!due) {
      return;
    }

    const nextText = this.formatReasoning();
    if (nextText === this.lastRenderedText) {
      return;
    }

    this.thinkingUpdateInFlight = this.connector
      .editMessage(this.chatId, this.placeholderMsgId, nextText, {
        retries: 0,
        suppressFallbackSend: true,
        formatMode: 'plain'
      })
      .then(() => {
        this.lastRenderedText = nextText;
        this.lastRenderAt = Date.now();
        this.reasoningRenderedOnce = true;
        this.lastReasoningRenderAt = Date.now();
        this.consecutiveEditFailures = 0;
      })
      .catch((error) => {
        this.consecutiveEditFailures += 1;
        log.warn('reasoning.update-failed', {
          chatId: this.chatId,
          consecutiveEditFailures: this.consecutiveEditFailures,
          error
        });
        if (this.consecutiveEditFailures >= this.maxEditFailures) {
          this.streamingDisabled = true;
          log.warn('reasoning.update-disabled-after-failures', { chatId: this.chatId });
        }
      })
      .finally(() => {
        this.thinkingUpdateInFlight = null;
      });

    await this.thinkingUpdateInFlight;
  }

  private async renderStatus(text: string): Promise<void> {
    if (
      this.sawDelta ||
      this.sawReasoning ||
      this.completed ||
      this.streamingDisabled ||
      !this.placeholderSent ||
      !this.placeholderMsgId ||
      this.thinkingUpdateInFlight
    ) {
      return;
    }

    const statusText = text.trim();
    if (!statusText || statusText === this.lastRenderedText) {
      return;
    }

    const now = Date.now();
    if (now - this.lastRenderAt < STATUS_MIN_INTERVAL_MS) {
      return;
    }

    this.stopThinkingRotateInterval();
    this.thinkingUpdateInFlight = this.connector
      .editMessage(this.chatId, this.placeholderMsgId, statusText, {
        retries: 0,
        suppressFallbackSend: true
      })
      .then(() => {
        this.lastRenderedText = statusText;
        this.lastRenderAt = Date.now();
        this.consecutiveEditFailures = 0;
      })
      .catch((error) => {
        this.consecutiveEditFailures += 1;
        log.warn('status.update-failed', {
          chatId: this.chatId,
          consecutiveEditFailures: this.consecutiveEditFailures,
          error
        });
        if (this.consecutiveEditFailures >= this.maxEditFailures) {
          this.streamingDisabled = true;
          log.warn('status.update-disabled-after-failures', { chatId: this.chatId });
        }
      })
      .finally(() => {
        this.thinkingUpdateInFlight = null;
      });

    await this.thinkingUpdateInFlight;
  }

  async handleEvent(event: AgentEvent): Promise<void> {
    if (this.completed) {
      return;
    }

    if (event.type === 'reasoning') {
      await this.renderReasoning(event.text);
      return;
    }

    if (event.type === 'status') {
      // 純 thinking 模式只顯示 reasoning / 思考語，不顯示工具或等待狀態
      if (this.reasoningMode) {
        return;
      }
      await this.renderStatus(event.text);
      return;
    }

    if (event.type === 'delta') {
      const isFirstDelta = !this.sawDelta;
      this.sawDelta = true;
      this.buffer += event.text;
      // 純 thinking 模式：答案不漸進顯示，只累積供 finalize 覆蓋使用
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
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.stopFlushInterval();
    this.stopThinkingRotateInterval();
    await this.awaitFlush();
    await this.awaitThinkingUpdate();

    const resolvedText = finalText.trim() || this.finalEventText.trim() || this.buffer.trim();
    if (!resolvedText) {
      log.info('stream.finalize-empty', { chatId: this.chatId });
      return;
    }

    log.info('stream.finalizing', {
      chatId: this.chatId,
      placeholderSent: this.placeholderSent,
      textLength: resolvedText.length,
      sawDelta: this.sawDelta,
      streamingDisabled: this.streamingDisabled
    });

    // 刪除占位（思考中）訊息，改發一則全新的最終答案，
    // 讓最終訊息帶「完成當下」的時間戳，方便看出整體耗時。
    // 僅在連接器支援刪除時採用，否則退回原地編輯。
    if (
      this.finalizeAsNewMessage &&
      this.placeholderSent &&
      this.placeholderMsgId &&
      this.connector.deleteMessage
    ) {
      await this.deletePlaceholder();
      await this.connector.sendMessage(this.chatId, resolvedText, {
        retries: 2,
        throwOnError: true,
        retryOnTimeout: false,
        parseMode: 'markdown-v2'
      });
      log.info('stream.finalized-via-new-message', {
        chatId: this.chatId,
        textLength: resolvedText.length
      });
      return;
    }

    if (!this.placeholderSent || !this.placeholderMsgId) {
      await this.connector.sendMessage(this.chatId, resolvedText, {
        retries: 2,
        throwOnError: true,
        retryOnTimeout: false,
        parseMode: 'markdown-v2'
      });
      return;
    }

    if (resolvedText.length <= MAX_SINGLE_MESSAGE_LENGTH) {
      try {
        await this.connector.editMessage(this.chatId, this.placeholderMsgId, resolvedText, {
          retries: 0,
          suppressFallbackSend: true,
          formatMode: 'markdown-v2'
        });
        log.info('stream.finalized-via-edit', {
          chatId: this.chatId,
          textLength: resolvedText.length
        });
        return;
      } catch (error) {
        log.warn('final.edit-failed', { chatId: this.chatId, error });
      }
    }

    try {
      await this.connector.editMessage(
        this.chatId,
        this.placeholderMsgId,
        '✅ 已完成，以下分段送出：',
        {
          retries: 0,
          suppressFallbackSend: true,
          formatMode: 'plain'
        }
      );
    } catch (error) {
      log.warn('final.placeholder-update-failed', { chatId: this.chatId, error });
    }

    await this.connector.sendMessage(this.chatId, resolvedText, {
      retries: 2,
      throwOnError: true,
      retryOnTimeout: false,
      parseMode: 'markdown-v2'
    });
    log.info('stream.finalized-via-send', {
      chatId: this.chatId,
      textLength: resolvedText.length
    });
  }

  async fail(message: string): Promise<void> {
    if (this.completed) {
      return;
    }
    this.completed = true;
    this.stopFlushInterval();
    this.stopThinkingRotateInterval();
    await this.awaitFlush();
    await this.awaitThinkingUpdate();

    const fallback = message.trim() || this.latestErrorMessage.trim() || '⚠️ 生成中斷';
    log.warn('stream.failed', {
      chatId: this.chatId,
      placeholderSent: this.placeholderSent,
      fallbackLength: fallback.length,
      sawDelta: this.sawDelta,
      streamingDisabled: this.streamingDisabled
    });

    if (!this.placeholderSent || !this.placeholderMsgId) {
      await this.connector.sendMessage(this.chatId, fallback, {
        retries: 1,
        throwOnError: false,
        retryOnTimeout: false
      });
      return;
    }

    try {
      await this.connector.editMessage(this.chatId, this.placeholderMsgId, fallback, {
        retries: 0,
        suppressFallbackSend: true,
        formatMode: 'plain'
      });
    } catch (error) {
      log.warn('failure.edit-failed', { chatId: this.chatId, error });
      await this.connector.sendMessage(this.chatId, fallback, {
        retries: 1,
        throwOnError: false,
        retryOnTimeout: false
      });
    }
  }

  private stopFlushInterval(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  private async awaitFlush(): Promise<void> {
    if (!this.flushInFlight) {
      return;
    }
    try {
      await this.flushInFlight;
    } catch {
      // noop
    }
  }

  private async awaitThinkingUpdate(): Promise<void> {
    if (!this.thinkingUpdateInFlight) {
      return;
    }
    try {
      await this.thinkingUpdateInFlight;
    } catch {
      // noop
    }
  }

  private async deletePlaceholder(): Promise<void> {
    if (!this.placeholderMsgId || !this.connector.deleteMessage) {
      return;
    }
    try {
      await this.connector.deleteMessage(this.chatId, this.placeholderMsgId);
    } catch (error) {
      log.warn('final.placeholder-delete-failed', { chatId: this.chatId, error });
    }
  }

  private buildStreamingText(): string {
    if (!this.sawDelta) {
      return '🤔 思考中...';
    }
    return `✍️ 回覆中...\n\n${this.buffer}`.trimEnd();
  }

  private async maybeFlush(force: boolean): Promise<void> {
    if (
      this.reasoningMode ||
      this.streamingDisabled ||
      this.completed ||
      !this.placeholderSent ||
      !this.placeholderMsgId ||
      !this.sawDelta ||
      this.flushInFlight
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

    this.flushInFlight = this.connector
      .editMessage(this.chatId, this.placeholderMsgId, nextText, {
        retries: 0,
        suppressFallbackSend: true,
        formatMode: 'plain'
      })
      .then(() => {
        this.lastRenderedText = nextText;
        this.lastRenderAt = Date.now();
        this.lastRenderedBufferLength = this.buffer.length;
        this.consecutiveEditFailures = 0;
      })
      .catch((error) => {
        this.consecutiveEditFailures += 1;
        log.warn('stream.edit-failed', {
          chatId: this.chatId,
          consecutiveEditFailures: this.consecutiveEditFailures,
          error
        });
        if (this.consecutiveEditFailures >= this.maxEditFailures) {
          this.streamingDisabled = true;
          log.warn('stream.disabled-after-edit-failures', { chatId: this.chatId });
        }
      })
      .finally(() => {
        this.flushInFlight = null;
      });

    await this.flushInFlight;
  }
}
