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

export interface UnifiedMessage {
  id: string;
  chatId?: string;
  content: string;
  attachments?: UnifiedAttachment[];
  sender: UserProfile;
  timestamp: number;
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
  sendPlaceholder(chatId: string, text: string): Promise<string>;

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
    }
  ): Promise<void>;

  pinMessage?(chatId: string, messageId: string): Promise<void>;
  unpinMessage?(chatId: string, messageId: string): Promise<void>;

  onMessage(handler: (msg: UnifiedMessage) => void): void;
}
