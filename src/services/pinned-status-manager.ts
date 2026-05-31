import type { Connector } from '../types/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('pinned-status');

export type PinnedSnapshot = {
  model: string;
  activeSchedules: number;
  recentErrors: number;
  memorySize: number;
  lastRequestAt?: number;
};

type PinnedStatusManagerOptions = {
  throttleMs?: number;
};

export class PinnedStatusManager {
  private messageId: string | null = null;
  private lastRenderedText = '';
  private pendingSnapshot: PinnedSnapshot | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private readonly throttleMs: number;

  constructor(
    private readonly connector: Connector,
    private readonly chatId: string,
    options: PinnedStatusManagerOptions = {}
  ) {
    this.throttleMs = options.throttleMs ?? 5000;
  }

  async initialize(snapshot: PinnedSnapshot): Promise<void> {
    const text = this.renderText(snapshot);
    this.messageId = await this.connector.sendPlaceholder(this.chatId, text);
    this.lastRenderedText = text;
    if (this.messageId && this.connector.pinMessage) {
      try {
        await this.connector.pinMessage(this.chatId, this.messageId);
      } catch (err) {
        log.warn('pin_failed', { err });
      }
    }
  }

  async update(snapshot: PinnedSnapshot): Promise<void> {
    this.pendingSnapshot = snapshot;
    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    if (this.flushTimer) return;
    if (elapsed >= this.throttleMs) {
      await this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.throttleMs - elapsed);
  }

  private async flush(): Promise<void> {
    if (!this.pendingSnapshot || !this.messageId) return;
    const text = this.renderText(this.pendingSnapshot);
    this.pendingSnapshot = null;
    if (text === this.lastRenderedText) return;
    this.lastFlushAt = Date.now();
    try {
      await this.connector.editMessage(this.chatId, this.messageId, text, {
        retries: 0,
        suppressFallbackSend: true,
        formatMode: 'markdown-v2'
      });
      this.lastRenderedText = text;
    } catch (err) {
      log.warn('edit_failed', { err });
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.messageId && this.connector.unpinMessage) {
      try {
        await this.connector.unpinMessage(this.chatId, this.messageId);
      } catch {
        // best-effort
      }
    }
    this.messageId = null;
  }

  private renderText(s: PinnedSnapshot): string {
    const lines = [
      '📌 *TeleNexus 狀態*',
      `Model: \`${s.model}\``,
      `Active schedules: ${s.activeSchedules}`,
      `Recent errors (24h): ${s.recentErrors}`,
      `Memory size: ${s.memorySize}`
    ];
    if (s.lastRequestAt) {
      const minutesAgo = Math.floor((Date.now() - s.lastRequestAt) / 60000);
      lines.push(`Last request: ${minutesAgo}m ago`);
    }
    return lines.join('\n');
  }
}
