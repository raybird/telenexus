import { Telegraf } from 'telegraf';
import { Agent } from 'https';
import { createConnection } from 'net';
import fs from 'fs';
import path from 'path';
import type { Connector, UnifiedMessage } from '../types/index.js';

const DEFAULT_TELEGRAM_API_TIMEOUT_MS = 15000;
const DEFAULT_TELEGRAM_API_RETRY_COUNT = 1;
const DEFAULT_TELEGRAM_API_RETRY_DELAY_MS = 800;
const DEFAULT_TELEGRAM_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

type TelegramParseMode = 'HTML' | 'MarkdownV2';

type TelegramFormatMode = 'auto' | 'plain' | 'html';

type TelegramTableRenderMode = 'auto' | 'card' | 'code';

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
  private tableRenderMode: TelegramTableRenderMode;
  private maxImageBytes: number;

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
    this.tableRenderMode = this.parseTableRenderMode(process.env.TELEGRAM_TABLE_RENDER_MODE);
    this.maxImageBytes = parsePositiveInteger(
      process.env.TELEGRAM_IMAGE_MAX_BYTES,
      DEFAULT_TELEGRAM_IMAGE_MAX_BYTES
    );
  }

  private isAllowedUser(userId: string): boolean {
    return this.allowedUserIds.includes(userId);
  }

  private resolveProjectDir(): string {
    return process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
  }

  private resolveInboxDir(): string {
    return path.resolve(this.resolveProjectDir(), 'workspace', 'temp', 'inbox');
  }

  private ensureInboxDir(): void {
    fs.mkdirSync(this.resolveInboxDir(), { recursive: true });
  }

  private extensionFromMime(mimeType: string | undefined): string {
    switch ((mimeType || '').toLowerCase()) {
      case 'image/jpeg':
        return '.jpg';
      case 'image/png':
        return '.png';
      case 'image/webp':
        return '.webp';
      case 'image/gif':
        return '.gif';
      default:
        return '.img';
    }
  }

  private sanitizeBaseName(input: string): string {
    return input
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  private async downloadTelegramFile(fileId: string, preferredName?: string, mimeType?: string) {
    const file = await this.callTelegram(`getFile id=${fileId}`, () =>
      this.bot.telegram.getFile(fileId)
    );
    const filePath = file.file_path || '';

    if (!filePath) {
      throw new Error(`Telegram getFile missing file_path for ${fileId}`);
    }

    const estimatedSize = typeof file.file_size === 'number' ? file.file_size : 0;
    if (estimatedSize > this.maxImageBytes) {
      throw new Error(
        `Image too large (${Math.ceil(estimatedSize / 1024 / 1024)}MB > ${Math.floor(this.maxImageBytes / 1024 / 1024)}MB)`
      );
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${encodeURI(filePath)}`
    );
    if (!response.ok) {
      throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > this.maxImageBytes) {
      throw new Error(
        `Image too large (${Math.ceil(data.length / 1024 / 1024)}MB > ${Math.floor(this.maxImageBytes / 1024 / 1024)}MB)`
      );
    }

    this.ensureInboxDir();
    const parsed = path.parse(preferredName || path.basename(filePath));
    const fallbackName = this.sanitizeBaseName(parsed.name || `tg_${fileId}`) || `tg_${Date.now()}`;
    const ext = parsed.ext || this.extensionFromMime(mimeType);
    const savedName = `${Date.now()}_${fallbackName}${ext.startsWith('.') ? ext : `.${ext}`}`;
    const absolutePath = path.resolve(this.resolveInboxDir(), savedName);
    fs.writeFileSync(absolutePath, data);

    return {
      absolutePath,
      fileSize: data.length,
      fileName: savedName,
      mimeType: mimeType || response.headers.get('content-type') || undefined
    };
  }

  private parseFormatMode(raw: string | undefined): TelegramFormatMode {
    const normalized = (raw || 'auto').trim().toLowerCase();
    if (normalized === 'plain' || normalized === 'html' || normalized === 'auto') {
      return normalized;
    }
    return 'auto';
  }

  private parseTableRenderMode(raw: string | undefined): TelegramTableRenderMode {
    const normalized = (raw || 'auto').trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'card' || normalized === 'code') {
      return normalized;
    }
    return 'auto';
  }

  private isTableDividerLine(line: string): boolean {
    const normalized = line.trim();
    if (!normalized.includes('|')) {
      return false;
    }
    const compact = normalized.replace(/\|/g, '').replace(/:/g, '').replace(/-/g, '').trim();
    if (compact.length > 0) {
      return false;
    }
    return /-{3,}/.test(normalized);
  }

  private splitTableCells(line: string): string[] {
    const raw = line.trim();
    const withoutEdges = raw.replace(/^\|/, '').replace(/\|$/, '');
    return withoutEdges.split('|').map((cell) => cell.trim());
  }

  private parseMarkdownTableBlock(
    blockLines: string[]
  ): { headers: string[]; rows: string[][] } | null {
    if (blockLines.length < 2) {
      return null;
    }
    if (!this.isTableDividerLine(blockLines[1] || '')) {
      return null;
    }
    const headers = this.splitTableCells(blockLines[0] || '');
    if (headers.length === 0) {
      return null;
    }
    const rows = blockLines
      .slice(2)
      .map((line) => this.splitTableCells(line))
      .filter((row) => row.length > 0 && row.some((cell) => cell.length > 0));
    return { headers, rows };
  }

  private padCell(text: string, width: number): string {
    if (text.length >= width) {
      return text;
    }
    return text + ' '.repeat(width - text.length);
  }

  private tableToCodeBlock(headers: string[], rows: string[][]): string {
    const maxCols = Math.max(headers.length, ...rows.map((row) => row.length));
    const normalizedHeaders = Array.from({ length: maxCols }).map(
      (_, index) => headers[index] || `欄位${index + 1}`
    );
    const normalizedRows = rows.map((row) =>
      Array.from({ length: maxCols }).map((_, index) =>
        (row[index] || '').replace(/\s+/g, ' ').trim()
      )
    );

    const allRows = [normalizedHeaders, ...normalizedRows];
    const widths = Array.from({ length: maxCols }).map((_, col) => {
      const longest = Math.max(...allRows.map((row) => (row[col] || '').length));
      return Math.min(Math.max(longest, 4), 28);
    });

    const renderRow = (row: string[]) =>
      `| ${row
        .map((cell, index) => {
          const width = widths[index] || 28;
          const normalized = cell.length > width ? `${cell.slice(0, width - 1)}…` : cell;
          return this.padCell(normalized, width);
        })
        .join(' | ')} |`;

    const divider = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
    const lines = [
      renderRow(normalizedHeaders),
      divider,
      ...normalizedRows.map((row) => renderRow(row))
    ];
    return ['```', ...lines, '```'].join('\n');
  }

  private tableToCardBlock(headers: string[], rows: string[][]): string {
    if (rows.length === 0) {
      return ['【比較重點】', '- (無資料列)'].join('\n');
    }

    const titleHeader = headers[0] || '項目';
    const detailHeaders = headers.slice(1);
    const cards = rows.map((row, rowIndex) => {
      const title = row[0] || `${titleHeader} ${rowIndex + 1}`;
      const details = detailHeaders
        .map((header, detailIndex) => {
          const value = row[detailIndex + 1] || '—';
          return `- ${header}：${value}`;
        })
        .join('\n');
      return details ? [`• ${title}`, details].join('\n') : `• ${title}`;
    });

    return ['【比較重點】', ...cards].join('\n\n');
  }

  private resolveTableRenderMode(headers: string[], rows: string[][]): 'card' | 'code' {
    if (this.tableRenderMode === 'card' || this.tableRenderMode === 'code') {
      return this.tableRenderMode;
    }

    const allCells = [headers, ...rows].flat();
    const longest = allCells.reduce((max, item) => Math.max(max, item.length), 0);
    const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 0);
    if (columnCount > 3 || longest > 24) {
      return 'card';
    }
    return 'code';
  }

  private normalizeMarkdownTables(text: string): string {
    const lines = text.split('\n');
    const output: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const current = lines[i] || '';
      const next = lines[i + 1] || '';
      const looksLikeTableStart = current.includes('|') && this.isTableDividerLine(next);
      if (!looksLikeTableStart) {
        output.push(current);
        i += 1;
        continue;
      }

      const blockLines = [current, next];
      let cursor = i + 2;
      while (cursor < lines.length) {
        const candidate = lines[cursor] || '';
        if (!candidate.includes('|') || candidate.trim().length === 0) {
          break;
        }
        blockLines.push(candidate);
        cursor += 1;
      }

      const parsed = this.parseMarkdownTableBlock(blockLines);
      if (!parsed) {
        output.push(current);
        i += 1;
        continue;
      }

      const mode = this.resolveTableRenderMode(parsed.headers, parsed.rows);
      const transformed =
        mode === 'card'
          ? this.tableToCardBlock(parsed.headers, parsed.rows)
          : this.tableToCodeBlock(parsed.headers, parsed.rows);
      output.push(transformed);
      i = cursor;
    }

    return output.join('\n');
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
    const preparedChunk = this.normalizeMarkdownTables(chunk);

    if (this.formatMode === 'plain') {
      return { text: preparedChunk };
    }

    if (this.formatMode === 'html') {
      const text = this.looksLikeMarkdown(preparedChunk)
        ? this.markdownToHtml(preparedChunk)
        : preparedChunk;
      return { text, parseMode: 'HTML' };
    }

    // auto mode
    if (this.looksLikeHtml(preparedChunk)) {
      return { text: preparedChunk, parseMode: 'HTML' };
    }
    if (this.looksLikeMarkdown(preparedChunk)) {
      return { text: this.markdownToHtml(preparedChunk), parseMode: 'HTML' };
    }
    return { text: preparedChunk };
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
    options?: { retries?: number; retryOnTimeout?: boolean }
  ): Promise<T> {
    const retries = options?.retries ?? this.apiRetryCount;
    const retryOnTimeout = options?.retryOnTimeout ?? true;
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
        if (error instanceof TelegramApiTimeoutError && !retryOnTimeout) {
          console.warn(`[Telegram] ${label} timeout without retry (${elapsed}ms):`, error);
          throw error;
        }
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
    allowFormatting: boolean,
    retries?: number,
    retryOnTimeout?: boolean
  ) {
    const label = `sendMessage chat=${chatId} chunk=${chunkIndex + 1}/${totalChunks}`;
    const formatted = allowFormatting ? this.formatChunkForTelegram(chunk) : { text: chunk };
    const callOptions =
      retries !== undefined || retryOnTimeout !== undefined
        ? {
            ...(retries !== undefined ? { retries } : {}),
            ...(retryOnTimeout !== undefined ? { retryOnTimeout } : {})
          }
        : undefined;

    const sendPlain = async () =>
      this.callTelegram(label, () => this.bot.telegram.sendMessage(chatId, chunk), callOptions);

    if (!formatted.parseMode) {
      await sendPlain();
      return;
    }

    const parseMode: TelegramParseMode = formatted.parseMode;

    try {
      await this.callTelegram(
        label,
        () =>
          this.bot.telegram.sendMessage(chatId, formatted.text, {
            parse_mode: parseMode
          }),
        callOptions
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

      if (!this.isAllowedUser(userId)) {
        console.warn(
          `[Telegram] Blocked unauthorized access from: ${userId} (${ctx.from.first_name})`
        );
        return;
      }

      if (!this.messageHandler) {
        return;
      }

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
    });

    this.bot.on('photo', async (ctx) => {
      const userId = ctx.from.id.toString();

      if (!this.isAllowedUser(userId)) {
        console.warn(
          `[Telegram] Blocked unauthorized photo from: ${userId} (${ctx.from.first_name})`
        );
        return;
      }

      if (!this.messageHandler) {
        return;
      }

      try {
        const photos = ctx.message.photo || [];
        const bestPhoto = photos[photos.length - 1];
        if (!bestPhoto) {
          return;
        }

        const downloaded = await this.downloadTelegramFile(
          bestPhoto.file_id,
          undefined,
          'image/jpeg'
        );
        const caption = (ctx.message.caption || '').trim();
        const content = caption || '使用者上傳了一張圖片';
        const attachment = {
          kind: 'image' as const,
          path: downloaded.absolutePath,
          fileName: downloaded.fileName,
          fileSize: downloaded.fileSize,
          ...(downloaded.mimeType ? { mimeType: downloaded.mimeType } : {})
        };
        const unifiedMsg: UnifiedMessage = {
          id: ctx.message.message_id.toString(),
          chatId: ctx.chat.id.toString(),
          content,
          attachments: [attachment],
          sender: {
            id: userId,
            name: ctx.from.first_name || 'Unknown',
            platform: 'telegram'
          },
          timestamp: ctx.message.date * 1000,
          raw: ctx.message
        };
        this.messageHandler(unifiedMsg);
      } catch (error) {
        console.error('[Telegram] Failed to process photo message:', error);
        await this.sendMessage(ctx.chat.id.toString(), '❌ 圖片接收失敗，請稍後再試。');
      }
    });

    this.bot.on('document', async (ctx) => {
      const userId = ctx.from.id.toString();

      if (!this.isAllowedUser(userId)) {
        console.warn(
          `[Telegram] Blocked unauthorized document from: ${userId} (${ctx.from.first_name})`
        );
        return;
      }

      if (!this.messageHandler) {
        return;
      }

      const mimeType = (ctx.message.document.mime_type || '').toLowerCase();
      if (!mimeType.startsWith('image/')) {
        return;
      }

      try {
        const downloaded = await this.downloadTelegramFile(
          ctx.message.document.file_id,
          ctx.message.document.file_name,
          ctx.message.document.mime_type
        );
        const caption = (ctx.message.caption || '').trim();
        const content = caption || '使用者上傳了一張圖片';
        const attachment = {
          kind: 'image' as const,
          path: downloaded.absolutePath,
          fileName: downloaded.fileName,
          fileSize: downloaded.fileSize,
          ...(downloaded.mimeType ? { mimeType: downloaded.mimeType } : {})
        };
        const unifiedMsg: UnifiedMessage = {
          id: ctx.message.message_id.toString(),
          chatId: ctx.chat.id.toString(),
          content,
          attachments: [attachment],
          sender: {
            id: userId,
            name: ctx.from.first_name || 'Unknown',
            platform: 'telegram'
          },
          timestamp: ctx.message.date * 1000,
          raw: ctx.message
        };
        this.messageHandler(unifiedMsg);
      } catch (error) {
        console.error('[Telegram] Failed to process document image message:', error);
        await this.sendMessage(ctx.chat.id.toString(), '❌ 圖片接收失敗，請稍後再試。');
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

  async sendMessage(
    chatId: string,
    text: string,
    options?: { retries?: number; throwOnError?: boolean; retryOnTimeout?: boolean }
  ): Promise<void> {
    try {
      const chunks = this.splitMessage(text);
      console.log(`[Telegram] Sending message chat=${chatId} chunks=${chunks.length}`);
      const allowFormatting = chunks.length === 1;
      for (let i = 0; i < chunks.length; i += 1) {
        await this.sendChunk(
          chatId,
          chunks[i]!,
          i,
          chunks.length,
          allowFormatting,
          options?.retries,
          options?.retryOnTimeout
        );
      }
    } catch (error) {
      console.error(`[Telegram] Failed to send message to ${chatId}:`, error);
      if (options?.throwOnError) {
        throw error;
      }
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

  async editMessage(
    chatId: string,
    messageId: string,
    newText: string,
    options?: { retries?: number; suppressFallbackSend?: boolean }
  ): Promise<void> {
    try {
      const chunks = this.splitMessage(newText);
      const firstChunk = chunks[0] || '';
      const allowFormatting = chunks.length === 1;
      const formatted = allowFormatting
        ? this.formatChunkForTelegram(firstChunk)
        : { text: firstChunk };
      const callOptions = options?.retries !== undefined ? { retries: options.retries } : undefined;

      // 1. Edit the original message (placeholder) with the first chunk
      try {
        if (formatted.parseMode) {
          const parseMode: TelegramParseMode = formatted.parseMode;
          await this.callTelegram(
            `editMessage chat=${chatId} message=${messageId}`,
            () =>
              this.bot.telegram.editMessageText(
                chatId,
                parseInt(messageId, 10),
                undefined,
                formatted.text,
                {
                  parse_mode: parseMode
                }
              ),
            callOptions
          );
        } else {
          await this.callTelegram(
            `editMessage chat=${chatId} message=${messageId}`,
            () =>
              this.bot.telegram.editMessageText(
                chatId,
                parseInt(messageId, 10),
                undefined,
                formatted.text
              ),
            callOptions
          );
        }
      } catch (error) {
        if (!formatted.parseMode || !this.isParseModeError(error)) {
          throw error;
        }
        console.warn(
          `[Telegram] editMessage chat=${chatId} message=${messageId} parse_mode failed, fallback to plain text.`
        );
        await this.callTelegram(
          `editMessage chat=${chatId} message=${messageId}`,
          () =>
            this.bot.telegram.editMessageText(
              chatId,
              parseInt(messageId, 10),
              undefined,
              firstChunk
            ),
          callOptions
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
      if (!options?.suppressFallbackSend) {
        await this.sendMessage(chatId, newText, {
          throwOnError: true,
          retries: Math.max(this.apiRetryCount, 3)
        });
      }
    }
  }
}
