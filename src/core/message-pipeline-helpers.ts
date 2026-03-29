import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import type { Connector, UnifiedAttachment, UnifiedMessage } from '../types/index.js';
import { resolveProjectDir } from '../utils/paths.js';

const log = createLogger('message-pipeline.helpers');

export type PendingImageBundle = {
  attachments: UnifiedAttachment[];
  updatedAt: number;
};

export type FileDirective = {
  path: string;
  caption?: string;
};

export function extractFileDirectives(response: string): {
  cleanedText: string;
  directives: FileDirective[];
} {
  const directives: FileDirective[] = [];
  const markerRegex = /\[\[SEND_FILE:\s*([^\]|]+?)(?:\s*\|\s*([^\]]+))?\s*\]\]/g;
  const cleanedText = response.replace(
    markerRegex,
    (_full, rawPath: string, rawCaption?: string) => {
      const filePath = (rawPath || '').trim();
      if (!filePath) {
        return '';
      }
      const caption = (rawCaption || '').trim();
      directives.push({ path: filePath, ...(caption ? { caption } : {}) });
      return '';
    }
  );

  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim(),
    directives
  };
}

export function resolveProjectFilePath(rawPath: string): string | null {
  const projectDir = resolveProjectDir();
  const normalizedProjectDir = path.resolve(projectDir);
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(normalizedProjectDir, rawPath);

  if (resolved === normalizedProjectDir || !resolved.startsWith(normalizedProjectDir + path.sep)) {
    return null;
  }

  return resolved;
}

export function resolveTempFilePath(rawPath: string): string | null {
  const resolved = resolveProjectFilePath(rawPath);
  if (!resolved) {
    return null;
  }

  const projectDir = resolveProjectDir();
  const tempDir = path.resolve(projectDir, 'workspace', 'temp');
  if (resolved === tempDir || resolved.startsWith(tempDir + path.sep)) {
    return resolved;
  }

  return null;
}

export function formatFileValidationError(targetPath: string, reason: string): string {
  return `⚠️ 檔案傳送略過：${targetPath}（${reason}）`;
}

export function buildAttachmentPrompt(attachments: UnifiedAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) {
    return '';
  }

  const imageRefs = attachments
    .filter((item) => item.kind === 'image')
    .map((item) => {
      const ref = toWorkspaceAttachmentRef(item.path);
      if (!ref) {
        return null;
      }
      const label = item.fileName || path.basename(item.path);
      return `- ${label}: ${ref}`;
    })
    .filter((item): item is string => Boolean(item));

  if (imageRefs.length === 0) {
    return '';
  }

  return [
    '【使用者上傳圖片】',
    '以下圖片為使用者剛上傳，請直接讀取並依照使用者問題分析：',
    ...imageRefs
  ].join('\n');
}

export function parsePendingImageTtlMs(raw: string | undefined): number {
  const fallback = 10 * 60 * 1000;
  const parsed = Number.parseInt(raw?.trim() || '', 10);
  if (!Number.isFinite(parsed) || parsed < 30 * 1000) {
    return fallback;
  }
  return parsed;
}

export function isImageOnlyPlaceholderMessage(msg: UnifiedMessage): boolean {
  const attachments = msg.attachments || [];
  if (attachments.length === 0) {
    return false;
  }

  const text = msg.content.trim();
  if (!text) {
    return true;
  }

  return text === '使用者上傳了一張圖片';
}

export function consumePendingImages(
  msg: UnifiedMessage,
  pendingImageByUser: Map<string, PendingImageBundle>,
  now: number,
  pendingImageTtlMs: number
): {
  kind: 'stored' | 'merged' | 'unchanged';
  message: UnifiedMessage;
} {
  const userId = msg.sender.id;
  const pendingBundle = pendingImageByUser.get(userId);
  if (pendingBundle && now - pendingBundle.updatedAt > pendingImageTtlMs) {
    pendingImageByUser.delete(userId);
  }

  if (isImageOnlyPlaceholderMessage(msg)) {
    const current = pendingImageByUser.get(userId);
    const merged = [...(current?.attachments || []), ...(msg.attachments || [])];
    pendingImageByUser.set(userId, { attachments: merged, updatedAt: now });
    return { kind: 'stored', message: msg };
  }

  const pendingForUser = pendingImageByUser.get(userId);
  if (
    pendingForUser &&
    pendingForUser.attachments.length > 0 &&
    !msg.content.trim().startsWith('/')
  ) {
    pendingImageByUser.delete(userId);
    return {
      kind: 'merged',
      message: {
        ...msg,
        attachments: [...pendingForUser.attachments, ...(msg.attachments || [])]
      }
    };
  }

  return { kind: 'unchanged', message: msg };
}

export async function deliverFileDirectives(
  connector: Connector,
  chatId: string,
  directives: FileDirective[],
  maxSendFileBytes: number
): Promise<void> {
  for (const directive of directives) {
    const resolvedPath = resolveProjectFilePath(directive.path);
    if (!resolvedPath) {
      await connector.sendMessage(
        chatId,
        formatFileValidationError(directive.path, '只允許專案目錄內路徑')
      );
      continue;
    }

    if (!resolveTempFilePath(directive.path)) {
      await connector.sendMessage(
        chatId,
        formatFileValidationError(directive.path, '自動回傳檔案僅允許 workspace/temp/ 路徑')
      );
      continue;
    }

    if (!fs.existsSync(resolvedPath)) {
      await connector.sendMessage(chatId, formatFileValidationError(directive.path, '檔案不存在'));
      continue;
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      await connector.sendMessage(
        chatId,
        formatFileValidationError(directive.path, '目標不是檔案')
      );
      continue;
    }

    if (stat.size > maxSendFileBytes) {
      await connector.sendMessage(
        chatId,
        formatFileValidationError(
          directive.path,
          `檔案過大（${Math.ceil(stat.size / 1024 / 1024)}MB > ${Math.floor(maxSendFileBytes / 1024 / 1024)}MB）`
        )
      );
      continue;
    }

    await connector.sendFile(chatId, resolvedPath, directive.caption);
  }
}

export class ThinkingMessenger {
  private placeholderMsgId = '';
  private thinkingInterval: NodeJS.Timeout | null = null;
  private messageIndex = 0;
  private thinkingActive = false;
  private thinkingUpdateInFlight: Promise<void> | null = null;

  constructor(
    private readonly connector: Connector,
    private readonly chatId: string,
    private readonly thinkingMessages: string[]
  ) {}

  private async flushThinkingUpdate(): Promise<void> {
    if (!this.thinkingUpdateInFlight) {
      return;
    }
    try {
      await this.thinkingUpdateInFlight;
    } catch {
      // thinking update failure should not block final response
    }
  }

  private queueThinkingUpdate(nextText: string): void {
    if (!this.thinkingActive || !this.placeholderMsgId || this.thinkingUpdateInFlight) {
      return;
    }

    this.thinkingUpdateInFlight = (async () => {
      if (!this.thinkingActive) {
        return;
      }
      await this.connector.editMessage(this.chatId, this.placeholderMsgId, nextText, {
        retries: 0,
        suppressFallbackSend: true
      });
    })()
      .catch((error) => {
        log.warn('thinking.update-failed', { chatId: this.chatId, error });
      })
      .finally(() => {
        this.thinkingUpdateInFlight = null;
      });
  }

  async start(): Promise<void> {
    try {
      this.placeholderMsgId = await this.connector.sendPlaceholder(
        this.chatId,
        this.thinkingMessages[0]!
      );

      if (this.placeholderMsgId) {
        this.thinkingActive = true;
        this.thinkingInterval = setInterval(() => {
          this.messageIndex = (this.messageIndex + 1) % this.thinkingMessages.length;
          this.queueThinkingUpdate(this.thinkingMessages[this.messageIndex]!);
        }, 3000);
      }
    } catch (error) {
      log.warn('placeholder.send-failed', { chatId: this.chatId, error });
    }
  }

  async stop(): Promise<void> {
    if (this.thinkingInterval) {
      clearInterval(this.thinkingInterval);
    }
    this.thinkingActive = false;
    await this.flushThinkingUpdate();
  }

  async deliverFinalResponse(finalText: string): Promise<void> {
    if (this.placeholderMsgId) {
      try {
        await this.connector.editMessage(
          this.chatId,
          this.placeholderMsgId,
          '✅ 已完成，回覆如下：',
          {
            retries: 0,
            suppressFallbackSend: true
          }
        );
      } catch (error) {
        log.warn('placeholder.finalize-failed', { chatId: this.chatId, error });
      }
    }

    try {
      await this.connector.sendMessage(this.chatId, finalText, {
        retries: 2,
        throwOnError: true,
        retryOnTimeout: false
      });
    } catch (error) {
      log.error('response.deliver-failed', { chatId: this.chatId, error });
    }
  }
}

function toWorkspaceAttachmentRef(rawPath: string): string | null {
  if (!rawPath) {
    return null;
  }

  const projectDir = resolveProjectDir();
  const workspaceDir = path.resolve(projectDir, 'workspace');
  const resolved = path.resolve(rawPath);
  if (!(resolved === workspaceDir || resolved.startsWith(workspaceDir + path.sep))) {
    return null;
  }

  const relativeToWorkspace = path.relative(workspaceDir, resolved).split(path.sep).join('/');
  return relativeToWorkspace ? `@./${relativeToWorkspace}` : null;
}
