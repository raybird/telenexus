import type { Connector, UnifiedAttachment, UnifiedMessage } from '../types/index.js';
import type { AIAgent } from './agent.js';
import type { CommandRouter } from './command-router.js';
import { executionQueue } from './execution-queue.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import type { MemoryManager } from './memory.js';
import type { Scheduler } from './scheduler.js';
import fs from 'fs';
import path from 'path';

type MessagePipelineOptions = {
  connector: Connector;
  resolveConnector?: (msg: UnifiedMessage) => Connector;
  commandRouter: CommandRouter;
  memory: MemoryManager;
  scheduler: Scheduler;
  userAgent: AIAgent;
  chatRunnerAgent: AIAgent;
  useRunnerForChat: boolean;
  chatRunnerPercent: number;
  chatRunnerOnlyUsers: Set<string>;
  shouldSummarize: (content: string) => boolean;
  buildPrompt: (userMessage: string, userId: string, mode?: 'full' | 'compact') => string;
  enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void;
  recordRuntimeIssue: (scope: string, error: unknown) => void;
  writeContextSnapshots: () => void;
};

type PendingImageBundle = {
  attachments: UnifiedAttachment[];
  updatedAt: number;
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

type FileDirective = {
  path: string;
  caption?: string;
};

function extractFileDirectives(response: string): {
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

function resolveProjectFilePath(rawPath: string): string | null {
  const projectDir = process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
  const normalizedProjectDir = path.resolve(projectDir);
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(normalizedProjectDir, rawPath);

  if (resolved === normalizedProjectDir || !resolved.startsWith(normalizedProjectDir + path.sep)) {
    return null;
  }

  return resolved;
}

function resolveTempFilePath(rawPath: string): string | null {
  const resolved = resolveProjectFilePath(rawPath);
  if (!resolved) {
    return null;
  }

  const projectDir = process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
  const tempDir = path.resolve(projectDir, 'workspace', 'temp');
  if (resolved === tempDir || resolved.startsWith(tempDir + path.sep)) {
    return resolved;
  }

  return null;
}

function formatFileValidationError(targetPath: string, reason: string): string {
  return `⚠️ 檔案傳送略過：${targetPath}（${reason}）`;
}

function toWorkspaceAttachmentRef(rawPath: string): string | null {
  if (!rawPath) {
    return null;
  }

  const projectDir = process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
  const workspaceDir = path.resolve(projectDir, 'workspace');
  const resolved = path.resolve(rawPath);
  if (!(resolved === workspaceDir || resolved.startsWith(workspaceDir + path.sep))) {
    return null;
  }

  const relativeToWorkspace = path.relative(workspaceDir, resolved).split(path.sep).join('/');
  return relativeToWorkspace ? `@./${relativeToWorkspace}` : null;
}

function buildAttachmentPrompt(attachments: UnifiedAttachment[] | undefined): string {
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

function parsePendingImageTtlMs(raw: string | undefined): number {
  const fallback = 10 * 60 * 1000;
  const parsed = Number.parseInt(raw?.trim() || '', 10);
  if (!Number.isFinite(parsed) || parsed < 30 * 1000) {
    return fallback;
  }
  return parsed;
}

function isImageOnlyPlaceholderMessage(msg: UnifiedMessage): boolean {
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

function hashToBucket(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function createMessagePipeline(options: MessagePipelineOptions) {
  const pendingNewSessionUsers = new Set<string>();
  const fullPromptCounterByUser = new Map<string, number>();
  const pendingImageByUser = new Map<string, PendingImageBundle>();
  const pendingImageTtlMs = parsePendingImageTtlMs(process.env.IMAGE_ATTACHMENT_PENDING_TTL_MS);
  const maxSendFileBytes = 45 * 1024 * 1024;
  const summaryFollowupEnabled = parseBool(process.env.SUMMARY_FOLLOWUP_ENABLED, true);
  const fullPromptEvery = parsePositiveInt(process.env.CHAT_FULL_PROMPT_EVERY, 6);
  const summaryFollowupMinLength = parsePositiveInt(process.env.SUMMARY_FOLLOWUP_MIN_LENGTH, 500);
  const summaryFollowupMaxLength = parsePositiveInt(process.env.SUMMARY_FOLLOWUP_MAX_LENGTH, 320);
  const thinkingMessages = [
    '🤔 思考中...',
    '🧠 正在理解問題...',
    '🔍 搜尋相關資訊...',
    '⚡ 處理中...',
    '💭 組織回答...',
    '🎯 分析脈絡...'
  ];

  return async (incomingMsg: UnifiedMessage): Promise<void> => {
    const now = Date.now();
    let msg = incomingMsg;
    const connector = options.resolveConnector?.(msg) || options.connector;
    const attachmentCount = msg.attachments?.length || 0;
    console.log(
      `📩 [${msg.sender.platform}] ${msg.sender.name}: ${msg.content}${attachmentCount > 0 ? ` (attachments=${attachmentCount})` : ''}`
    );
    const userId = msg.sender.id;
    const targetChatId = msg.chatId || userId;

    const pendingBundle = pendingImageByUser.get(userId);
    if (pendingBundle && now - pendingBundle.updatedAt > pendingImageTtlMs) {
      pendingImageByUser.delete(userId);
    }

    if (isImageOnlyPlaceholderMessage(msg)) {
      const current = pendingImageByUser.get(userId);
      const merged = [...(current?.attachments || []), ...(msg.attachments || [])];
      pendingImageByUser.set(userId, { attachments: merged, updatedAt: now });
      await connector.sendMessage(
        targetChatId,
        '📎 已收到圖片。請再傳一則文字描述你要我做的事，我會搭配圖片一起處理。'
      );
      return;
    }

    const pendingForUser = pendingImageByUser.get(userId);
    if (
      pendingForUser &&
      pendingForUser.attachments.length > 0 &&
      !msg.content.trim().startsWith('/')
    ) {
      msg = {
        ...msg,
        attachments: [...pendingForUser.attachments, ...(msg.attachments || [])]
      };
      pendingImageByUser.delete(userId);
    }

    options.scheduler.resetSilenceTimer(userId);
    options.writeContextSnapshots();

    const commandHandled = await options.commandRouter.handleMessage(msg, {
      connector,
      memory: options.memory,
      scheduler: options.scheduler,
      requestNewSession: (targetUserId: string) => {
        pendingNewSessionUsers.add(targetUserId);
      }
    });
    if (commandHandled) {
      return;
    }

    const isPassthroughCommand = options.commandRouter.isPassthroughCommand(msg.content.trim());
    const forceNewSession = pendingNewSessionUsers.has(userId);
    if (forceNewSession) {
      pendingNewSessionUsers.delete(userId);
      console.log('[System] Applying one-time new session mode for this message.');
    }

    const queueStatus = executionQueue.getStatus(userId);
    if (queueStatus.running || queueStatus.pending > 0) {
      const ahead = queueStatus.pending + (queueStatus.running ? 1 : 0);
      await connector.sendMessage(
        targetChatId,
        `⏳ 目前有任務執行中（來源：${queueStatus.currentSource || 'unknown'}），已幫你排隊，前方約 ${ahead} 件。`,
        {
          retries: 1,
          retryOnTimeout: false
        }
      );
    }

    const isWhitelisted =
      options.chatRunnerOnlyUsers.size === 0 || options.chatRunnerOnlyUsers.has(msg.sender.id);
    const bucket = hashToBucket(`${msg.sender.id}:${msg.id}`);
    const useRunnerThisMessage =
      options.useRunnerForChat && isWhitelisted && bucket < options.chatRunnerPercent;
    const activeAgent = useRunnerThisMessage ? options.chatRunnerAgent : options.userAgent;
    console.log(
      `[System] Message execution mode: ${useRunnerThisMessage ? 'runner' : 'local'} (bucket=${bucket}, canary=${options.chatRunnerPercent}%, whitelist=${isWhitelisted})`
    );

    let placeholderMsgId = '';
    let thinkingInterval: NodeJS.Timeout | null = null;
    let messageIndex = 0;
    let thinkingActive = false;
    let thinkingUpdateInFlight: Promise<void> | null = null;

    const flushThinkingUpdate = async () => {
      if (!thinkingUpdateInFlight) {
        return;
      }
      try {
        await thinkingUpdateInFlight;
      } catch {
        // thinking update failure should not block final response
      }
    };

    const queueThinkingUpdate = (nextText: string) => {
      if (!thinkingActive || !placeholderMsgId || thinkingUpdateInFlight) {
        return;
      }

      thinkingUpdateInFlight = (async () => {
        if (!thinkingActive) {
          return;
        }
        await connector.editMessage(targetChatId, placeholderMsgId, nextText, {
          retries: 0,
          suppressFallbackSend: true
        });
      })()
        .catch((error) => {
          console.warn('Failed to update thinking message', error);
        })
        .finally(() => {
          thinkingUpdateInFlight = null;
        });
    };

    const deliverFinalResponse = async (finalText: string) => {
      if (placeholderMsgId) {
        try {
          await connector.editMessage(targetChatId, placeholderMsgId, '✅ 已完成，回覆如下：', {
            retries: 0,
            suppressFallbackSend: true
          });
        } catch (error) {
          console.warn('[System] Failed to finalize placeholder text.', error);
        }
      }

      try {
        await connector.sendMessage(targetChatId, finalText, {
          retries: 2,
          throwOnError: true,
          retryOnTimeout: false
        });
      } catch (error) {
        console.error('[System] Failed to deliver final Telegram response:', error);
      }
    };

    try {
      placeholderMsgId = await connector.sendPlaceholder(targetChatId, thinkingMessages[0]!);

      if (placeholderMsgId) {
        thinkingActive = true;
        thinkingInterval = setInterval(async () => {
          messageIndex = (messageIndex + 1) % thinkingMessages.length;
          queueThinkingUpdate(thinkingMessages[messageIndex]!);
        }, 3000);
      }
    } catch (error) {
      console.warn('Failed to send placeholder', error);
    }

    try {
      let userSummary: string | undefined;

      if (!isPassthroughCommand && options.shouldSummarize(msg.content)) {
        console.log('📝 [Memory] User input meets summary criteria, generating summary...');
        userSummary = await executionQueue.enqueue(userId, 'chat-summary', 'normal', () =>
          activeAgent.summarize(msg.content)
        );
      }

      options.memory.addMessage(userId, 'user', msg.content, userSummary);

      let promptForAgent = msg.content.trim();
      if (!isPassthroughCommand) {
        const currentCounter = fullPromptCounterByUser.get(userId) || 0;
        const shouldUseFullPrompt = forceNewSession || currentCounter % fullPromptEvery === 0;
        promptForAgent = options.buildPrompt(
          msg.content,
          userId,
          shouldUseFullPrompt ? 'full' : 'compact'
        );
        fullPromptCounterByUser.set(userId, currentCounter + 1);
        const attachmentPrompt = buildAttachmentPrompt(msg.attachments);
        if (attachmentPrompt) {
          promptForAgent = `${promptForAgent}\n\n${attachmentPrompt}`;
        }
      }

      if (isPassthroughCommand) {
        console.log(`📤 [System] Passthrough command -> CLI: ${promptForAgent}`);
      } else {
        console.log(`📤 [System] Sending prompt to AI (length: ${promptForAgent.length} chars)`);
      }

      const rawResponse = await executionQueue.enqueue(userId, 'chat', 'high', () =>
        activeAgent.chat(promptForAgent, {
          isPassthroughCommand,
          forceNewSession
        })
      );

      const { cleanedText, directives } = extractFileDirectives(rawResponse);
      const response = cleanedText || rawResponse;

      console.log(`📥 [AI] Reply length: ${response.length}`);

      if (response && !response.startsWith('Error')) {
        options.memory.addMessage(userId, 'model', response);

        options.enqueueMemoriaSync?.({
          userId,
          userMessage: msg.content,
          modelMessage: response,
          platform: msg.sender.platform,
          isPassthroughCommand,
          forceNewSession
        });
      }

      if (thinkingInterval) {
        clearInterval(thinkingInterval);
      }
      thinkingActive = false;
      await flushThinkingUpdate();

      await deliverFinalResponse(response);

      if (directives.length > 0) {
        for (const directive of directives) {
          const resolvedPath = resolveProjectFilePath(directive.path);
          if (!resolvedPath) {
            await connector.sendMessage(
              targetChatId,
              formatFileValidationError(directive.path, '只允許專案目錄內路徑')
            );
            continue;
          }

          if (!resolveTempFilePath(directive.path)) {
            await connector.sendMessage(
              targetChatId,
              formatFileValidationError(directive.path, '自動回傳檔案僅允許 workspace/temp/ 路徑')
            );
            continue;
          }

          if (!fs.existsSync(resolvedPath)) {
            await connector.sendMessage(
              targetChatId,
              formatFileValidationError(directive.path, '檔案不存在')
            );
            continue;
          }

          const stat = fs.statSync(resolvedPath);
          if (!stat.isFile()) {
            await connector.sendMessage(
              targetChatId,
              formatFileValidationError(directive.path, '目標不是檔案')
            );
            continue;
          }

          if (stat.size > maxSendFileBytes) {
            await connector.sendMessage(
              targetChatId,
              formatFileValidationError(
                directive.path,
                `檔案過大（${Math.ceil(stat.size / 1024 / 1024)}MB > ${Math.floor(maxSendFileBytes / 1024 / 1024)}MB）`
              )
            );
            continue;
          }

          await connector.sendFile(targetChatId, resolvedPath, directive.caption);
        }
      }

      const shouldSendSummaryFollowup =
        summaryFollowupEnabled &&
        !isPassthroughCommand &&
        response.length >= summaryFollowupMinLength &&
        options.shouldSummarize(response) &&
        !response.startsWith('Error');

      if (shouldSendSummaryFollowup) {
        void (async () => {
          try {
            console.log('📝 [Followup] Generating post-reply summary...');
            const summary = await executionQueue.enqueue(
              userId,
              'chat-followup-summary',
              'low',
              () => activeAgent.summarize(response)
            );
            const normalized = summary.trim();
            if (!normalized) {
              return;
            }
            const brief =
              normalized.length > summaryFollowupMaxLength
                ? normalized.slice(0, summaryFollowupMaxLength - 3) + '...'
                : normalized;
            const followup = `📝 補充摘要\n${brief}`;
            await connector.sendMessage(targetChatId, followup);
          } catch (error) {
            console.warn('📝 [Followup] Summary generation failed:', error);
          }
        })();
      }
    } catch (error) {
      console.error('❌ Error processing message:', error);
      options.recordRuntimeIssue('message-processing', error);
      options.writeContextSnapshots();
      const errorMsg = 'Sorry, I encountered an error while exercising my powers.';

      if (thinkingInterval) {
        clearInterval(thinkingInterval);
      }
      thinkingActive = false;
      await flushThinkingUpdate();

      await deliverFinalResponse(errorMsg);
    }
  };
}
