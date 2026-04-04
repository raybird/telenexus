import type { Connector } from '../types/index.js';
import type { AgentEvent } from './agent-result.js';
import { createLogger } from './logger.js';
import { parsePositiveInt } from '../utils/env.js';

const log = createLogger('telegram-stream');

const DEFAULT_EDIT_THROTTLE_MS = 1000;
const DEFAULT_MIN_DELTA_CHARS = 40;
const DEFAULT_FORCE_FLUSH_MS = 2500;
const DEFAULT_EARLY_FLUSH_CHARS = 120;
const DEFAULT_MAX_EDIT_FAILURES = 3;
const MAX_SINGLE_MESSAGE_LENGTH = 3900;

type TelegramStreamRendererOptions = {
  editThrottleMs?: number;
  minDeltaChars?: number;
  forceFlushMs?: number;
  earlyFlushChars?: number;
  maxEditFailures?: number;
};

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

  private readonly editThrottleMs: number;
  private readonly minDeltaChars: number;
  private readonly forceFlushMs: number;
  private readonly earlyFlushChars: number;
  private readonly maxEditFailures: number;

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
  }

  async start(): Promise<void> {
    if (this.placeholderSent) {
      return;
    }
    this.placeholderMsgId = await this.connector.sendPlaceholder(this.chatId, '🤔 思考中...');
    this.placeholderSent = this.placeholderMsgId.length > 0;
    this.lastRenderedText = '🤔 思考中...';
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
    }
  }

  async handleEvent(event: AgentEvent): Promise<void> {
    if (this.completed) {
      return;
    }

    if (event.type === 'delta') {
      const isFirstDelta = !this.sawDelta;
      this.sawDelta = true;
      this.buffer += event.text;
      if (isFirstDelta) {
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
    await this.awaitFlush();

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

    if (!this.placeholderSent || !this.placeholderMsgId) {
      await this.connector.sendMessage(this.chatId, resolvedText, {
        retries: 2,
        throwOnError: true,
        retryOnTimeout: false
      });
      return;
    }

    if (resolvedText.length <= MAX_SINGLE_MESSAGE_LENGTH) {
      try {
        await this.connector.editMessage(this.chatId, this.placeholderMsgId, resolvedText, {
          retries: 0,
          suppressFallbackSend: true
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
      retryOnTimeout: false
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
    await this.awaitFlush();

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

  private buildStreamingText(): string {
    if (!this.sawDelta) {
      return '🤔 思考中...';
    }
    return `✍️ 回覆中...\n\n${this.buffer}`.trimEnd();
  }

  private async maybeFlush(force: boolean): Promise<void> {
    if (
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
