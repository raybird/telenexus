import type { Connector, UnifiedMessage } from '../types/index.js';
import { executionQueue } from './execution-queue.js';
import type { AIAgent } from './agent.js';
import type { CommandRouter } from './command-router.js';
import type { MemoryManager } from './memory.js';
import type { Scheduler } from './scheduler.js';

type RunnerSelectionOptions = {
  userId: string;
  messageId: string;
  useRunnerForChat: boolean;
  chatRunnerOnlyUsers: Set<string>;
  chatRunnerPercent: number;
  chatRunnerAgent: AIAgent;
  userAgent: AIAgent;
};

type PreflightOptions = {
  msg: UnifiedMessage;
  connector: Connector;
  commandRouter: CommandRouter;
  memory: MemoryManager;
  scheduler: Scheduler;
  pendingNewSessionUsers: Set<string>;
  writeContextSnapshots: () => void;
};

function hashToBucket(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export async function runCommandPreflight(options: PreflightOptions): Promise<{
  handled: boolean;
  isPassthroughCommand: boolean;
  forceNewSession: boolean;
}> {
  const userId = options.msg.sender.id;

  options.scheduler.resetSilenceTimer(userId);
  options.writeContextSnapshots();

  const commandHandled = await options.commandRouter.handleMessage(options.msg, {
    connector: options.connector,
    memory: options.memory,
    scheduler: options.scheduler,
    requestNewSession: (targetUserId: string) => {
      options.pendingNewSessionUsers.add(targetUserId);
    }
  });

  if (commandHandled) {
    return { handled: true, isPassthroughCommand: false, forceNewSession: false };
  }

  const isPassthroughCommand = options.commandRouter.isPassthroughCommand(
    options.msg.content.trim()
  );
  const forceNewSession = options.pendingNewSessionUsers.has(userId);
  if (forceNewSession) {
    options.pendingNewSessionUsers.delete(userId);
    console.log('[System] Applying one-time new session mode for this message.');
  }

  return { handled: false, isPassthroughCommand, forceNewSession };
}

export async function maybeNotifyQueueAhead(
  connector: Connector,
  userId: string,
  chatId: string
): Promise<void> {
  const queueStatus = executionQueue.getStatus(userId);
  if (queueStatus.running || queueStatus.pending > 0) {
    const ahead = queueStatus.pending + (queueStatus.running ? 1 : 0);
    await connector.sendMessage(
      chatId,
      `⏳ 目前有任務執行中（來源：${queueStatus.currentSource || 'unknown'}），已幫你排隊，前方約 ${ahead} 件。`,
      {
        retries: 1,
        retryOnTimeout: false
      }
    );
  }
}

export function selectActiveAgent(options: RunnerSelectionOptions): {
  activeAgent: AIAgent;
  useRunnerThisMessage: boolean;
  bucket: number;
  isWhitelisted: boolean;
} {
  const isWhitelisted =
    options.chatRunnerOnlyUsers.size === 0 || options.chatRunnerOnlyUsers.has(options.userId);
  const bucket = hashToBucket(`${options.userId}:${options.messageId}`);
  const useRunnerThisMessage =
    options.useRunnerForChat && isWhitelisted && bucket < options.chatRunnerPercent;

  return {
    activeAgent: useRunnerThisMessage ? options.chatRunnerAgent : options.userAgent,
    useRunnerThisMessage,
    bucket,
    isWhitelisted
  };
}
