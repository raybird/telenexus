import { Telegraf } from 'telegraf';
import { Agent } from 'https';
import { createConnection } from 'net';
import fs from 'fs';
import type { Connector, UnifiedMessage } from '../types/index.js';

const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 15000;
const DEFAULT_TELEGRAM_API_RETRY_COUNT = 1;
const DEFAULT_TELEGRAM_API_RETRY_DELAY_MS = 800;

type TelegramParseMode = 'HTML' | 'MarkdownV2';

type TelegramFormatMode = 'auto' | 'plain' | 'html';

type FormattedChunk = {
  text: string;
  parseMode?: TelegramParseMode;
};

class TelegramApiTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TelegramApiTimeoutError';
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export class TelegramConnector implements Connector {
  public name = 'Telegram';
  private bot!: Telegraf;
  private messageHandler: ((msg: UnifiedMessage) => void) | null = null;
  private allowedUserIds: string[];
  private token: string;
  private apiTimeoutMs: number;
  private apiRetryCount: number;
  private apiRetryDelayMs: number;
  private formatMode: TelegramFormatMode;

  constructor(token: string, allowedUserIds: string[]) {
    this.token = token;
    this.allowedUserIds = allowedUserIds;
    this.apiTimeoutMs = parsePositiveInteger(
      process.env.TELEGRAM_API_TIMEOUT_MS,
      DEFAULT_TELEGRAM_API_TIMEOUT_MS
    );
    this.apiRetryCount = parsePositiveInteger(
      process.env.TELEGRAM_API_RETRY_COUNT,
      DEFAULT_TELEGRAM_API_RETRY_COUNT
    );
    this.apiRetryDelayMs = parsePositiveInteger(
      process.env.TELEGRAM_API_RETRY_DELAY_MS,
      DEFAULT_TELEGRAM_API_RETRY_DELAY_MS
    );
    this.formatMode = this.parseFormatMode(process.env.TELEGRAM_FORMAT_MODE);
  }

  private parseFormatMode(raw: string | undefined): TelegramFormatMode {
    const normalized = (raw || 'auto').trim().toLowerCase();
    if (normalized === 'plain' || normalized === 'html' || normalized === 'auto') {
      return normalized;
    }
    return 'auto';
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private looksLikeMarkdown(text: string): boolean {
    return Boolean(
      text.match(/```[\s\S]*?```/) ||
      text.match(/`[^`\n]+`/) ||
      text.match(/\*\*[^*]+\*\*/) ||
      text.match(/__[^_]+__/) ||
      text.match(/(^|\n)#{1,6}\s+/) ||
      text.match(/(^|\n)\s*[-*]\s+/) ||
      text.match(/(^|\n)\s*\d+\.\s+/) ||
      text.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/)
    );
  }

  private looksLikeHtml(text: string): boolean {
    return /<\/?[a-z][^>]*>/i.test(text);
  }

  private markdownToHtml(text: string): string {
    const fencedBlocks: string[] = [];
    const inlineCodes: string[] = [];

    const takeFenced = text.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_full, code) => {
      const token = `@@FENCED_${fencedBlocks.length}@@`;
      fencedBlocks.push(`<pre><code>${this.escapeHtml(String(code || ''))}</code></pre>`);
      return token;
    });

    const takeInline = takeFenced.replace(/`([^`\n]+)`/g, (_full, code) => {
      const token = `@@INLINE_${inlineCodes.length}@@`;
      inlineCodes.push(`<code>${this.escapeHtml(String(code || ''))}</code>`);
      return token;
    });

    let html = this.escapeHtml(takeInline);

    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_full, label, url) => {
      const safeLabel = String(label || '');
      const safeUrl = String(url || '').replace(/&amp;/g, '&');
      return `<a href="${this.escapeHtml(safeUrl)}">${safeLabel}</a>`;
    });

    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/__([^_]+)__/g, '<b>$1</b>');

    html = html
      .split('\n')
      .map((line) => {
        if (/^#{1,6}\s+/.test(line)) {
          return `<b>${line.replace(/^#{1,6}\s+/, '')}</b>`;
        }
        return line;
      })
      .join('\n');

    html = html.replace(/@@INLINE_(\d+)@@/g, (_full, index) => inlineCodes[Number(index)] || '');
    html = html.replace(/@@FENCED_(\d+)@@/g, (_full, index) => fencedBlocks[Number(index)] || '');

    return html;
  }

  private formatChunkForTelegram(chunk: string): FormattedChunk {
    if (this.formatMode === 'plain') {
      return { text: chunk };
    }

    if (this.formatMode === 'html') {
      const text = this.looksLikeMarkdown(chunk) ? this.markdownToHtml(chunk) : chunk;
      return { text, parseMode: 'HTML' };
    }

    // auto mode
    if (this.looksLikeHtml(chunk)) {
      return { text: chunk, parseMode: 'HTML' };
    }
    if (this.looksLikeMarkdown(chunk)) {
      return { text: this.markdownToHtml(chunk), parseMode: 'HTML' };
    }
    return { text: chunk };
  }

  private isParseModeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const err = error as {
      message?: string;
      response?: { error_code?: number; description?: string };
    };
    const message = err.message || err.response?.description || '';
    const statusCode = err.response?.error_code;
    return (
      statusCode === 400 &&
      /can't parse entities|unsupported start tag|can't find end tag|parse entities/i.test(message)
    );
  }

  private splitMessage(text: string, limit: number = 4096): string[] {
    const chunks: string[] = [];
    let currentChunk = '';

    const lines = text.split('\n');

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > limit) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
          currentChunk = '';
        }

        // If a single line is too long, force split it
        if (line.length > limit) {
          for (let i = 0; i < line.length; i += limit) {
            chunks.push(line.substring(i, i + limit));
          }
        } else {
          currentChunk = line;
        }
      } else {
        currentChunk += (currentChunk ? '\n' : '') + line;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks.length > 0 ? chunks : [text];
  }

  private probeIPv6(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({
        host: 'api.telegram.org',
        port: 443,
        family: 6,
        timeout: 2000 // 2s connection timeout
      });

      socket.on('connect', () => {
        socket.end();
        resolve(true);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private withTimeout<T>(task: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TelegramApiTimeoutError(label, this.apiTimeoutMs));
      }, this.apiTimeoutMs);

      task
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof TelegramApiTimeoutError) {
      return true;
    }

    if (!error || typeof error !== 'object') {
      return false;
    }

    const err = error as {
      code?: string;
      message?: string;
      response?: { error_code?: number };
    };
    const code = err.code || '';
    const statusCode = err.response?.error_code;
    const message = err.message || '';

    if (
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'EAI_AGAIN' ||
      code === 'ECONNABORTED'
    ) {
      return true;
    }

    if (typeof statusCode === 'number' && (statusCode === 429 || statusCode >= 500)) {
      return true;
    }

    return /timeout|socket hang up|network error/i.test(message);
  }

  private async callTelegram<T>(
    label: string,
    operation: () => Promise<T>,
    options?: { retries?: number }
  ): Promise<T> {
    const retries = options?.retries ?? this.apiRetryCount;
    let attempt = 0;

    while (true) {
      attempt += 1;
      const startedAt = Date.now();

      try {
        const result = await this.withTimeout(operation(), label);
        const elapsed = Date.now() - startedAt;
        if (attempt > 1) {
          console.log(`[Telegram] ${label} succeeded on retry #${attempt - 1} (${elapsed}ms)`);
        } else {
          console.log(`[Telegram] ${label} succeeded (${elapsed}ms)`);
        }
        return result;
      } catch (error) {
        const elapsed = Date.now() - startedAt;
        const retryable = this.isRetryableError(error);
        const hasRetryLeft = attempt <= retries;

        console.warn(
          `[Telegram] ${label} failed (${elapsed}ms, attempt=${attempt}, retryable=${retryable}):`,
          error
        );

        if (!retryable || !hasRetryLeft) {
          throw error;
        }

        await this.sleep(this.apiRetryDelayMs);
      }
    }
  }

  private async sendChunk(
    chatId: string,
    chunk: string,
    chunkIndex: number,
    totalChunks: number,
    allowFormatting: boolean
  ) {
    const label = `sendMessage chat=${chatId} chunk=${chunkIndex + 1}/${totalChunks}`;
    const formatted = allowFormatting ? this.formatChunkForTelegram(chunk) : { text: chunk };

    const sendPlain = async () =>
      this.callTelegram(label, () => this.bot.telegram.sendMessage(chatId, chunk));

    if (!formatted.parseMode) {
      await sendPlain();
      return;
    }

    const parseMode: TelegramParseMode = formatted.parseMode;

    try {
      await this.callTelegram(label, () =>
        this.bot.telegram.sendMessage(chatId, formatted.text, {
          parse_mode: parseMode
        })
      );
    } catch (error) {
      if (!this.isParseModeError(error)) {
        throw error;
      }
      console.warn(`[Telegram] ${label} parse_mode failed, fallback to plain text.`);
      await sendPlain();
    }
  }

  async initialize(): Promise<void> {
    const ipv6Available = await this.probeIPv6();
    const family = ipv6Available ? undefined : 4;
    console.log(
      `[Telegram] Network probe: IPv6 is ${ipv6Available ? 'available' : 'unreachable'}. using IPv${family || 6}`
    );

    this.bot = new Telegraf(this.token, {
      telegram: {
        agent: new Agent({ keepAlive: true, family })
      }
    });

    console.log(`[Telegram] Initializing with allowed users: ${this.allowedUserIds.join(', ')}`);

    this.bot.on('text', async (ctx) => {
      const userId = ctx.from.id.toString();

      // 白名單檢查
      if (!this.allowedUserIds.includes(userId)) {
        console.warn(
          `[Telegram] Blocked unauthorized access from: ${userId} (${ctx.from.first_name})`
        );
        return;
      }

      if (this.messageHandler) {
        const unifiedMsg: UnifiedMessage = {
          id: ctx.message.message_id.toString(),
          chatId: ctx.chat.id.toString(),
          content: ctx.message.text,
          sender: {
            id: userId,
            name: ctx.from.first_name || 'Unknown',
            platform: 'telegram'
          },
          timestamp: ctx.message.date * 1000,
          raw: ctx.message
        };
        this.messageHandler(unifiedMsg);
      }
    });

    this.bot.launch(() => {
      console.log('[Telegram] Bot launched successfully!');
    });

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  onMessage(handler: (msg: UnifiedMessage) => void): void {
    this.messageHandler = handler;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      const chunks = this.splitMessage(text);
      console.log(`[Telegram] Sending message chat=${chatId} chunks=${chunks.length}`);
      const allowFormatting = chunks.length === 1;
      for (let i = 0; i < chunks.length; i += 1) {
        await this.sendChunk(chatId, chunks[i]!, i, chunks.length, allowFormatting);
      }
    } catch (error) {
      console.error(`[Telegram] Failed to send message to ${chatId}:`, error);
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      const stream = fs.createReadStream(filePath);
      const label = `sendDocument chat=${chatId} file=${filePath}`;
      await this.callTelegram(label, () =>
        this.bot.telegram.sendDocument(
          chatId,
          { source: stream, filename: filePath.split('/').pop() || 'document' },
          caption ? { caption } : undefined
        )
      );
    } catch (error) {
      console.error(`[Telegram] Failed to send file ${filePath} to ${chatId}:`, error);
    }
  }

  async sendPlaceholder(chatId: string, text: string): Promise<string> {
    try {
      const msg = await this.callTelegram(`sendPlaceholder chat=${chatId}`, () =>
        this.bot.telegram.sendMessage(chatId, text)
      );
      return msg.message_id.toString();
    } catch (error) {
      console.error(`[Telegram] Failed to send placeholder to ${chatId}:`, error);
      return '';
    }
  }

  async editMessage(chatId: string, messageId: string, newText: string): Promise<void> {
    try {
      const chunks = this.splitMessage(newText);
      const firstChunk = chunks[0] || '';
      const allowFormatting = chunks.length === 1;
      const formatted = allowFormatting
        ? this.formatChunkForTelegram(firstChunk)
        : { text: firstChunk };

      // 1. Edit the original message (placeholder) with the first chunk
      try {
        if (formatted.parseMode) {
          const parseMode: TelegramParseMode = formatted.parseMode;
          await this.callTelegram(`editMessage chat=${chatId} message=${messageId}`, () =>
            this.bot.telegram.editMessageText(
              chatId,
              parseInt(messageId, 10),
              undefined,
              formatted.text,
              {
                parse_mode: parseMode
              }
            )
          );
        } else {
          await this.callTelegram(`editMessage chat=${chatId} message=${messageId}`, () =>
            this.bot.telegram.editMessageText(
              chatId,
              parseInt(messageId, 10),
              undefined,
              formatted.text
            )
          );
        }
      } catch (error) {
        if (!formatted.parseMode || !this.isParseModeError(error)) {
          throw error;
        }
        console.warn(
          `[Telegram] editMessage chat=${chatId} message=${messageId} parse_mode failed, fallback to plain text.`
        );
        await this.callTelegram(`editMessage chat=${chatId} message=${messageId}`, () =>
          this.bot.telegram.editMessageText(chatId, parseInt(messageId, 10), undefined, firstChunk)
        );
      }

      // 2. Send remaining chunks as new messages
      if (chunks.length > 1) {
        for (let i = 1; i < chunks.length; i++) {
          await this.sendChunk(chatId, chunks[i]!, i, chunks.length, false);
        }
      }
    } catch (error) {
      console.error(`[Telegram] Failed to edit message ${messageId}:`, error);
      // Fallback: try sending as new message(s) if edit fails
      await this.sendMessage(chatId, newText);
    }
  }
}
