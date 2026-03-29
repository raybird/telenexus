import type { Connector, UnifiedMessage } from '../types/index.js';
import type { AIAgent } from './agent.js';

export type MessagePipelineContext = {
  msg: UnifiedMessage;
  connector: Connector;
  userId: string;
  targetChatId: string;
  isPassthroughCommand: boolean;
  forceNewSession: boolean;
  activeAgent: AIAgent;
};

export function createMessagePipelineContext(
  msg: UnifiedMessage,
  connector: Connector,
  activeAgent: AIAgent,
  isPassthroughCommand: boolean,
  forceNewSession: boolean
): MessagePipelineContext {
  const userId = msg.sender.id;
  return {
    msg,
    connector,
    userId,
    targetChatId: msg.chatId || userId,
    isPassthroughCommand,
    forceNewSession,
    activeAgent
  };
}
