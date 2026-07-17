export interface UserProfile {
  id: string;
  name: string;
  platform: 'telegram' | 'console';
}

export interface UnifiedAttachment {
  kind: 'image';
  path: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface TelegramMessageContext {
  updateId: number;
  chatType: TelegramChatType;
  messageThreadId?: number;
}

export interface UnifiedMessage {
  id: string;
  chatId?: string;
  content: string;
  attachments?: UnifiedAttachment[];
  sender: UserProfile;
  timestamp: number;
  telegram?: TelegramMessageContext;
  raw?: unknown; // 原始訊息 payload，保留除錯用
}

export interface Connector {
  name: string;
  initialize(): Promise<void>;

  /**
   * 發送一般訊息
   */
  sendMessage(
    chatId: string,
    text: string,
    options?: {
      retries?: number;
      throwOnError?: boolean;
      retryOnTimeout?: boolean;
      parseMode?: 'auto' | 'plain' | 'markdown-v2';
      messageThreadId?: number;
    }
  ): Promise<void>;

  /**
   * 發送檔案（例如文件、報告）
   */
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;

  /**
   * 發送一個佔位訊息（例如 "Thinking..."），並回傳該訊息的 ID，以便後續編輯
   * @returns messageId
   */
  sendPlaceholder(
    chatId: string,
    text: string,
    options?: { messageThreadId?: number }
  ): Promise<string>;

  /**
   * 串流 Telegram 原生暫時草稿；只有支援此能力的連接器需要實作。
   */
  sendMessageDraft?(
    chatId: string,
    draftId: number,
    text: string,
    options?: { messageThreadId?: number; retries?: number }
  ): Promise<void>;

  /**
   * 顯示連接器原生的活動狀態（例如 Telegram typing）。
   */
  sendChatAction?(
    chatId: string,
    action: 'typing',
    options?: { messageThreadId?: number }
  ): Promise<void>;

  /**
   * 編輯已發送的訊息
   */
  editMessage(
    chatId: string,
    messageId: string,
    newText: string,
    options?: {
      retries?: number;
      suppressFallbackSend?: boolean;
      formatMode?: 'auto' | 'plain' | 'markdown-v2';
      throwOnError?: boolean;
    }
  ): Promise<void>;

  /**
   * 刪除已發送的訊息（並非所有連接器都支援；不支援時 renderer 會退回原地編輯）
   */
  deleteMessage?(chatId: string, messageId: string): Promise<void>;

  pinMessage?(chatId: string, messageId: string): Promise<void>;
  unpinMessage?(chatId: string, messageId: string): Promise<void>;

  onMessage(handler: (msg: UnifiedMessage) => void): void;
}
