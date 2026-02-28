import { Cron } from 'croner';
import { MemoryManager, type Schedule } from './memory.js';
import fs from 'fs';
import yaml from 'js-yaml';
import type { AIAgent } from './agent.js';
import { executionQueue } from './execution-queue.js';
import type { Connector } from '../types/index.js';

export class Scheduler {
  private jobs: Map<number, Cron> = new Map();
  private systemJobs: Map<string, Cron> = new Map();
  private silenceTimers: Map<string, NodeJS.Timeout> = new Map();
  private silenceTimerSeq: Map<string, number> = new Map();
  private lastReflectionFingerprint: Map<string, string> = new Map();
  private readonly SILENCE_TIMEOUT_MS = 30 * 60 * 1000; // 正式環境：30 分鐘
  private memory: MemoryManager;
  private gemini: AIAgent; // 改用 AIAgent 介面
  private connector: Connector;

  constructor(memory: MemoryManager, gemini: AIAgent, connector: Connector) {
    this.memory = memory;
    this.gemini = gemini;
    this.connector = connector;
  }

  private clearSilenceTimer(userId: string): void {
    const timer = this.silenceTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(userId);
      console.log(`[Scheduler] Cleared silence timer for user ${userId}`);
    }
  }

  private scheduleSilenceTimer(
    userId: string,
    delayMs: number = this.SILENCE_TIMEOUT_MS,
    source: string = 'default'
  ): void {
    this.clearSilenceTimer(userId);

    const nextSeq = (this.silenceTimerSeq.get(userId) || 0) + 1;
    this.silenceTimerSeq.set(userId, nextSeq);

    const timer = setTimeout(async () => {
      const activeSeq = this.silenceTimerSeq.get(userId);
      if (activeSeq !== nextSeq) {
        console.log(
          `[Scheduler] Skipping stale silence timer for user ${userId} (seq=${nextSeq}, active=${activeSeq})`
        );
        return;
      }

      console.log(
        `[Scheduler] Silence timer fired for user ${userId} (seq=${nextSeq}, source=${source})`
      );
      await this.triggerReflection(userId, 'silence', undefined, nextSeq);
    }, delayMs);

    this.silenceTimers.set(userId, timer);
    console.log(
      `[Scheduler] Scheduled silence timer for user ${userId} (seq=${nextSeq}, source=${source}, delayMs=${delayMs}, activeTimers=${this.silenceTimers.size})`
    );
  }

  private fingerprintReflection(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private getTimezone(): string {
    // 優先使用環境變數 (與 Docker 容器一致)
    if (process.env.TZ) {
      return process.env.TZ;
    }

    // 其次嘗試讀取設定檔
    try {
      if (fs.existsSync('ai-config.yaml')) {
        const fileContent = fs.readFileSync('ai-config.yaml', 'utf8');
        const config = yaml.load(fileContent) as any;
        return config?.timezone || 'Asia/Taipei';
      }
    } catch {
      // ignore error
    }

    return 'Asia/Taipei';
  }

  /**
   * 初始化排程器：從資料庫載入所有啟用的排程並啟動
   */
  async init(): Promise<void> {
    const schedules = this.memory.getActiveSchedules();
    console.log(`[Scheduler] Loading ${schedules.length} active schedule(s)...`);

    for (const schedule of schedules) {
      this.startJob(schedule);
    }

    // 初始化系統排程
    await this.initSystemSchedules();

    // 啟動時檢查使用者最後活動時間
    await this.checkStartupActivity();
  }

  /**
   * 啟動時檢查使用者活動狀態，決定是否觸發問候或追蹤
   */
  private async checkStartupActivity(): Promise<void> {
    const userId = process.env.ALLOWED_USER_ID;
    if (!userId) {
      console.log('[Scheduler] No ALLOWED_USER_ID set, skipping startup activity check.');
      return;
    }

    const lastMessageTime = this.memory.getLastMessageTime(userId);
    const now = Date.now();

    if (lastMessageTime === null) {
      // 資料庫沒有任何訊息紀錄，發送問候訊息
      console.log('[Scheduler] No message history found, sending greeting...');
      await this.connector.sendMessage(
        userId,
        '👋 嗨！我是 TeleNexus，您的 AI 助理。有什麼需要幫忙的嗎？'
      );
      this.resetSilenceTimer(userId);
    } else {
      const silenceMs = now - lastMessageTime;
      const silenceMinutes = Math.floor(silenceMs / 1000 / 60);
      console.log(`[Scheduler] Last message was ${silenceMinutes} minutes ago.`);

      if (silenceMs >= this.SILENCE_TIMEOUT_MS) {
        // 超過沉默時間，立即觸發追蹤
        console.log('[Scheduler] Silence exceeded threshold, triggering follow-up...');
        await this.triggerReflection(userId, 'silence');
      } else {
        // 尚未超過，設定剩餘時間的計時器
        const remainingMs = this.SILENCE_TIMEOUT_MS - silenceMs;
        console.log(
          `[Scheduler] Setting follow-up timer for ${Math.floor(remainingMs / 1000 / 60)} minutes...`
        );
        this.scheduleSilenceTimer(userId, remainingMs, 'startup-remaining');
      }
    }
  }

  /**
   * 初始化系統預設排程 (如每日摘要)
   */
  private async initSystemSchedules(): Promise<void> {
    // 每日 09:00 發送「每日對話摘要」
    const timezone = this.getTimezone();
    const dailySummaryJob = new Cron('0 9 * * *', { timezone }, async () => {
      console.log('[Scheduler] Triggering daily summary...');
      await this.executeDailySummary();
    });
    this.systemJobs.set('daily_summary', dailySummaryJob);
    console.log(
      `[Scheduler] Registered system job: daily_summary (09:00 daily) in timezone ${timezone}`
    );
  }

  /**
   * 啟動一個 cron 任務
   * @param schedule 排程資料
   */
  private startJob(schedule: Schedule): void {
    // 如果已存在相同 ID 的 Job，先停止它（避免重複掛載）
    if (this.jobs.has(schedule.id)) {
      console.log(`[Scheduler] Stopping duplicate job #${schedule.id}`);
      this.jobs.get(schedule.id)?.stop();
      this.jobs.delete(schedule.id);
    }

    try {
      const timezone = this.getTimezone();
      const job = new Cron(schedule.cron, { timezone }, async () => {
        console.log(`[Scheduler] Triggered: "${schedule.name}" (ID: ${schedule.id})`);
        await this.executeTask(schedule);
      });

      this.jobs.set(schedule.id, job);
      console.log(
        `[Scheduler] Started job #${schedule.id}: "${schedule.name}" with cron "${schedule.cron}" in timezone ${timezone}`
      );
    } catch (error) {
      console.error(`[Scheduler] Failed to start job #${schedule.id}:`, error);
    }
  }

  private validateCronExpression(cron: string): void {
    const normalized = cron.trim();
    const parts = normalized.split(/\s+/);
    if (parts.length !== 5) {
      throw new Error('Cron expression must contain 5 fields (minute hour day month weekday).');
    }

    try {
      const probe = new Cron(normalized, { timezone: this.getTimezone() }, async () => {
        return;
      });
      probe.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid cron expression: ${message}`);
    }
  }

  private sanitizeScheduleInput(
    name: string,
    cron: string,
    prompt: string
  ): {
    name: string;
    cron: string;
    prompt: string;
  } {
    const normalizedName = name.trim();
    const normalizedCron = cron.trim();
    const normalizedPrompt = prompt.trim();

    if (!normalizedName) {
      throw new Error('Schedule name is required.');
    }
    if (!normalizedPrompt) {
      throw new Error('Schedule prompt is required.');
    }

    this.validateCronExpression(normalizedCron);
    return {
      name: normalizedName,
      cron: normalizedCron,
      prompt: normalizedPrompt
    };
  }

  private extractKeywords(text: string): string[] {
    const stopwords = new Set([
      '請',
      '幫我',
      '一下',
      '這個',
      '那個',
      '今天',
      '現在',
      '可以',
      '是否',
      '如何',
      '什麼',
      '哪裡',
      'then',
      'that',
      'this',
      'with',
      'from',
      'what',
      'when',
      'where',
      'which',
      'would',
      'should',
      'could',
      'please',
      'help'
    ]);

    const tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && !stopwords.has(item));

    const unique: string[] = [];
    for (const token of tokens) {
      if (!unique.includes(token)) {
        unique.push(token);
      }
      if (unique.length >= 8) break;
    }
    return unique;
  }

  private truncateInline(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return normalized.slice(0, maxLength - 1) + '…';
  }

  private shouldRetryAiResponse(response: string): boolean {
    const normalized = response
      .trim()
      .replace(/^\[(Gemini|Opencode)\]\s*/i, '')
      .trim();
    const lower = normalized.toLowerCase();
    const looksLikeExecutionStub =
      (normalized.startsWith('我將') ||
        normalized.startsWith('我會') ||
        normalized.startsWith('我先') ||
        normalized.startsWith('接下來')) &&
      /(執行|調用|呼叫|run|execute)/i.test(normalized);
    return (
      /^Error calling (Gemini|Opencode):/i.test(normalized) ||
      normalized.startsWith('Error calling runner:') ||
      /^✨\s*\d+\s*分鐘內未完成/.test(normalized) ||
      /process terminated with signal sigkill/.test(lower) ||
      /process exited with code 1/.test(lower) ||
      looksLikeExecutionStub
    );
  }

  /**
   * 從 TeleNexus 內建記憶檢索長期上下文（不依賴 provider hook）
   */
  private async retrieveLongTermMemory(userId: string, prompt: string): Promise<string> {
    try {
      const recent = this.memory.getRecentMessages(userId, 80);
      if (recent.length === 0) {
        return '';
      }

      const keywords = this.extractKeywords(prompt);
      const loweredKeywords = keywords.map((item) => item.toLowerCase());

      const scored = recent
        .filter((item) => item.content.trim().length > 0)
        .map((item) => {
          const content = item.content.toLowerCase();
          let score = 0;
          for (const keyword of loweredKeywords) {
            if (content.includes(keyword)) {
              score += 1;
            }
          }
          return { ...item, score };
        });

      const matches =
        loweredKeywords.length > 0
          ? scored
              .filter((item) => item.score > 0)
              .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return b.timestamp - a.timestamp;
              })
              .slice(0, 5)
          : recent.slice(0, 3);

      if (matches.length === 0) {
        return '';
      }

      const lines = matches.map((item) => {
        const role = item.role === 'user' ? 'User' : 'AI';
        const time = new Date(item.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        return `- [${role}] (${time}) ${this.truncateInline(item.content, 180)}`;
      });

      const context = ['【記憶參考（TeleNexus）】', ...lines].join('\n');
      console.log(`[Scheduler] Retrieved memory context lines: ${lines.length}`);
      return context;
    } catch (error) {
      console.error('[Scheduler] Failed to retrieve long-term memory:', error);
      return '';
    }
  }

  /**
   * 執行排程任務
   */
  private async executeTask(schedule: Schedule): Promise<void> {
    try {
      // 1. 檢索長期記憶 (MCP Memory)
      const longTermMemory = await this.retrieveLongTermMemory(schedule.user_id, schedule.prompt);

      // 2. 組合 Prompt
      const fullPrompt = `
System: 你是 TeleNexus，一個具備強大工具執行能力的本地 AI 助理。
這是一個排程任務觸發的自動執行。
請用繁體中文回應。

${longTermMemory ? longTermMemory + '\n\n' : ''}
Scheduled Task: ${schedule.name}
User Request: ${schedule.prompt}

AI Response:
`.trim();

      // 3. 呼叫 Gemini CLI
      let response = await executionQueue.enqueue(schedule.user_id, 'scheduler-task', 'low', () =>
        this.gemini.chat(fullPrompt)
      );
      if (this.shouldRetryAiResponse(response)) {
        console.warn(`[Scheduler] Task #${schedule.id} first attempt failed, retrying once...`);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        response = await executionQueue.enqueue(
          schedule.user_id,
          'scheduler-task-retry',
          'low',
          () => this.gemini.chat(fullPrompt)
        );
        if (this.shouldRetryAiResponse(response)) {
          throw new Error('AI returned incomplete execution response after retry');
        }
      }
      console.log(
        `[Scheduler] Task #${schedule.id} completed. Response length: ${response.length}`
      );

      // 4. 儲存 AI 回應到記憶
      if (response && !response.startsWith('Error')) {
        this.memory.addMessage(schedule.user_id, 'model', response);
      }

      // 5. 將結果傳送給使用者
      const messageHeader = `🕐 [排程: ${schedule.name}]\n\n`;
      await this.connector.sendMessage(schedule.user_id, messageHeader + response);
    } catch (error) {
      console.error(`[Scheduler] Error executing task #${schedule.id}:`, error);
      const errorMessage = `❌ 排程任務 "${schedule.name}" 執行失敗：${error}`;
      this.memory.addMessage(schedule.user_id, 'model', errorMessage);
      await this.connector.sendMessage(schedule.user_id, errorMessage);
    }
  }

  /**
   * 新增排程並立即啟動
   */
  addSchedule(userId: string, name: string, cron: string, prompt: string): number {
    const sanitized = this.sanitizeScheduleInput(name, cron, prompt);
    const id = this.memory.addSchedule(userId, sanitized.name, sanitized.cron, sanitized.prompt);
    const schedule: Schedule = {
      id,
      user_id: userId,
      name: sanitized.name,
      cron: sanitized.cron,
      prompt: sanitized.prompt,
      created_at: Date.now(),
      is_active: true
    };
    this.startJob(schedule);
    return id;
  }

  /**
   * 更新排程並套用到執行中的 job
   */
  updateSchedule(userId: string, id: number, name: string, cron: string, prompt: string): Schedule {
    const existing = this.memory.getScheduleById(id);
    if (!existing) {
      throw new Error(`Schedule #${id} not found.`);
    }
    if (existing.user_id !== userId) {
      throw new Error(`Schedule #${id} does not belong to user ${userId}.`);
    }

    const sanitized = this.sanitizeScheduleInput(name, cron, prompt);
    this.memory.updateSchedule(id, sanitized.name, sanitized.cron, sanitized.prompt);

    const updated = this.memory.getScheduleById(id);
    if (!updated) {
      throw new Error(`Schedule #${id} was updated but cannot be loaded.`);
    }

    if (this.jobs.has(id)) {
      this.jobs.get(id)?.stop();
      this.jobs.delete(id);
    }
    if (updated.is_active) {
      this.startJob(updated);
    }

    console.log(`[Scheduler] Updated schedule #${id}`);
    return updated;
  }

  /**
   * 刪除排程並停止對應的 Job
   */
  removeSchedule(id: number): void {
    // 停止 Job
    if (this.jobs.has(id)) {
      this.jobs.get(id)?.stop();
      this.jobs.delete(id);
    }
    // 從資料庫刪除
    this.memory.removeSchedule(id);
    console.log(`[Scheduler] Removed schedule #${id}`);
  }

  /**
   * 取得所有排程（供使用者查詢）
   */
  listSchedules(userId: string): Schedule[] {
    return this.memory.getUserSchedules(userId);
  }

  /**
   * 停止所有排程（於程式關閉時調用）
   */
  shutdown(): void {
    console.log('[Scheduler] Shutting down all jobs...');
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
      console.log(`[Scheduler] Stopped job #${id}`);
    }
    this.jobs.clear();

    // 停止系統排程
    for (const [name, job] of this.systemJobs.entries()) {
      job.stop();
      console.log(`[Scheduler] Stopped system job: ${name}`);
    }
    this.systemJobs.clear();

    // 清除沉默計時器
    for (const timer of this.silenceTimers.values()) {
      clearTimeout(timer);
    }
    this.silenceTimers.clear();
    this.silenceTimerSeq.clear();
  }

  /**
   * 重新載入排程（當外部工具修改資料庫時調用）
   * 透過 SIGUSR1 信號觸發
   */
  async reload(): Promise<void> {
    console.log('[Scheduler] Reloading schedules from database...');

    // 停止所有使用者排程（保留系統排程）
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
      console.log(`[Scheduler] Stopped job #${id} for reload`);
    }
    this.jobs.clear();

    // 重新載入啟用的排程
    const schedules = this.memory.getActiveSchedules();
    console.log(`[Scheduler] Reloading ${schedules.length} active schedule(s)...`);

    for (const schedule of schedules) {
      this.startJob(schedule);
    }

    console.log('[Scheduler] Reload completed.');
  }

  /**
   * 重置使用者的沉默計時器 (每次收到訊息時呼叫)
   */
  resetSilenceTimer(userId: string): void {
    console.log(
      `[Scheduler] Timer reset for user ${userId}. Next trigger in ${this.SILENCE_TIMEOUT_MS / 1000 / 60} minutes.`
    );
    this.scheduleSilenceTimer(userId, this.SILENCE_TIMEOUT_MS, 'message-reset');
  }

  /**
   * 觸發追蹤提醒任務
   * @param userId 使用者 ID
   * @param type 觸發類型
   * @param messageIdToEdit 如果提供，結果將會編輯此訊息而不是發送新訊息
   */
  async triggerReflection(
    userId: string,
    type: 'silence' | 'manual' = 'silence',
    messageIdToEdit?: string,
    sourceTimerSeq?: number
  ): Promise<void> {
    console.log(
      `[Scheduler] Triggering reflection (type=${type}, user=${userId}, sourceTimerSeq=${sourceTimerSeq ?? 'n/a'})`
    );

    try {
      // 取得過去 24 小時對話
      const extendedHistory = this.memory.getExtendedHistory(userId, 24);
      const userHistory = extendedHistory.filter((msg) => msg.role === 'user');
      if (userHistory.length === 0) {
        console.log('[Scheduler] No recent conversations, skipping reflection.');
        return;
      }
      const modelHistory = extendedHistory.filter((msg) => msg.role === 'model');

      // 格式化使用者歷史（主證據）
      const userHistoryText = userHistory
        .map((msg) => {
          const time = new Date(msg.timestamp).toLocaleString('zh-TW');
          return `[${time}] User: ${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}`;
        })
        .join('\n\n');

      // 格式化模型歷史（次要上下文），僅取最近 12 筆避免雜訊
      const modelHistoryText = modelHistory
        .slice(-12)
        .map((msg) => {
          const time = new Date(msg.timestamp).toLocaleString('zh-TW');
          return `[${time}] AI: ${msg.content.substring(0, 500)}${msg.content.length > 500 ? '...' : ''}`;
        })
        .join('\n\n');

      // 檢索長期記憶
      const longTermMemory = await this.retrieveLongTermMemory(userId, '對話回顧 追蹤 待辦');

      // 組合追蹤提醒 Prompt
      const reflectionPrompt = `
System: 你是 TeleNexus，正在執行「追蹤提醒」任務。
請用繁體中文回應。

${longTermMemory ? longTermMemory + '\n\n' : ''}【任務說明】
請分析過去 24 小時的對話歷史，輸出可快速掃讀的分類摘要。
聚焦真正需要跟進的事項，避免冗長描述與固定前言。

【嚴格限制】
- 「User 訊息」是主證據；「AI 訊息」只能作為補充上下文
- 若某項目僅出現在 AI 訊息、未出現在 User 訊息，禁止列入待辦/問題
- 不可引用 AI 先前推測、假設、或未經使用者確認的專有名詞
- 若資訊不足，請明確寫「資訊不足，待使用者確認」

【證據標註規則】
- 每一項都要標註 evidence: user | mixed
- confidence 僅可為 high | medium | low
- 僅當 evidence=user 或 evidence=mixed 時，該項目才可列入輸出

【過去 24 小時 User 對話（主證據）】
${userHistoryText}

【過去 24 小時 AI 對話（僅供上下文）】
${modelHistoryText || '(none)'}

【輸出格式】
請嚴格使用以下格式（3 個分類都必須出現）：

🔴 未解決的問題：
- <項目>（evidence=<user|mixed>, confidence=<high|medium|low>）

🟡 可優化事項：
- <項目>（evidence=<user|mixed>, confidence=<high|medium|low>）

🟢 待辦提醒：
- <項目>（evidence=<user|mixed>, confidence=<high|medium|low>）

規則：
- 每個分類最多 2 點，總點數最多 5 點。
- 每點最多 2 句，句子要短。
- 禁止加入前言/結語（例如「我已分析」「以下為摘要」「已自動儲存」）。
- 若某分類沒有內容，該分類請填「- 無」。

若三個分類皆為「無」，請只輸出「近期對話無待處理事項」。
你的回應會自動儲存到記憶系統中，供未來參考。
`.trim();

      const response = await executionQueue.enqueue(userId, 'scheduler-reflection', 'low', () =>
        this.gemini.chat(reflectionPrompt)
      );
      const hasNoAction = !response || response.includes('無待處理事項');
      const currentFingerprint = this.fingerprintReflection(response || '');
      const previousFingerprint = this.lastReflectionFingerprint.get(userId);
      const isRepeatedReflection =
        !hasNoAction && Boolean(previousFingerprint) && previousFingerprint === currentFingerprint;

      if (isRepeatedReflection) {
        const checkedMsg = '✅ [追蹤檢查] 已完成檢查，目前沒有新的事項變化。';
        this.memory.addMessage(userId, 'model', checkedMsg);
        if (type === 'manual' && messageIdToEdit) {
          await this.connector.editMessage(userId, messageIdToEdit, checkedMsg);
        } else {
          await this.connector.sendMessage(userId, checkedMsg);
        }
      } else if (!hasNoAction) {
        const header = type === 'silence' ? '🔔 [追蹤提醒]\n\n' : '🔍 [手動追蹤]\n\n';
        const outgoing = header + response;
        this.memory.addMessage(userId, 'model', outgoing);

        if (messageIdToEdit) {
          await this.connector.editMessage(userId, messageIdToEdit, outgoing);
        } else {
          await this.connector.sendMessage(userId, outgoing);
        }

        this.lastReflectionFingerprint.set(userId, currentFingerprint);
      } else {
        console.log('[Scheduler] Follow-up completed, no action needed.');
        const noTodoMsg = '✨ 無待辦。';
        this.memory.addMessage(userId, 'model', noTodoMsg);
        // 沉默模式也發送精簡通知
        if (type === 'silence') {
          await this.connector.sendMessage(userId, noTodoMsg);
        } else if (type === 'manual' && messageIdToEdit) {
          await this.connector.editMessage(userId, messageIdToEdit, noTodoMsg);
        }
      }
    } catch (error) {
      console.error('[Scheduler] Error during reflection:', error);
      const errorMessage = `❌ 追蹤提醒執行失敗：${error}`;
      this.memory.addMessage(userId, 'model', errorMessage);
      if (type === 'manual' && messageIdToEdit) {
        await this.connector.editMessage(userId, messageIdToEdit, errorMessage);
      } else {
        await this.connector.sendMessage(userId, errorMessage);
      }
    }

    // 如果是沉默觸發，執行完成後再次設定計時器（每 30 分鐘循環）
    if (type === 'silence') {
      if (typeof sourceTimerSeq === 'number') {
        const activeSeq = this.silenceTimerSeq.get(userId);
        if (activeSeq !== sourceTimerSeq) {
          console.log(
            `[Scheduler] Skip re-schedule due to stale reflection source (user=${userId}, source=${sourceTimerSeq}, active=${activeSeq})`
          );
          return;
        }
      }

      console.log(`[Scheduler] Re-scheduling follow-up for user ${userId} in 30 minutes...`);
      this.scheduleSilenceTimer(userId, this.SILENCE_TIMEOUT_MS, 'reflection-recur');
    }
  }

  /**
   * 執行每日摘要
   */
  private async executeDailySummary(): Promise<void> {
    // 取得所有有對話記錄的使用者 (這裡簡化為使用 ALLOWED_USER_ID)
    const userId = process.env.ALLOWED_USER_ID;
    if (!userId) {
      console.log('[Scheduler] No ALLOWED_USER_ID set, skipping daily summary.');
      return;
    }

    console.log(`[Scheduler] Generating daily summary for user ${userId}`);

    try {
      const summaryPrompt = `
System: 你是 TeleNexus，正在執行「每日對話摘要」任務。
請用繁體中文回應。

【任務說明】
請回顧最近的對話記錄，輸出可快速掃讀的每日分類摘要。
以決策價值為優先，避免固定模板與重複句。

【輸出格式】
📅 每日摘要 - ${new Date().toLocaleDateString('zh-TW')}

🔴 高優先待處理：
- ...

🟡 可優化事項：
- ...

🟢 已解決/低優先：
- ...

規則：
- 三個分類都必須出現。
- 每個分類最多 2 點，總點數最多 5 點。
- 若某分類沒有內容，該分類請填「- 無」。
- 禁止加入前言/結語（例如「我已分析」「以下為摘要」）。

Next actions:
- <最重要的 1-2 個行動>

如果三個分類都為「無」且無行動，請回覆「✨ 目前沒有待處理事項！」
`.trim();

      const response = await executionQueue.enqueue(userId, 'scheduler-daily-summary', 'low', () =>
        this.gemini.chat(summaryPrompt)
      );
      const outgoing = '📅 [每日摘要]\n\n' + response;
      this.memory.addMessage(userId, 'model', outgoing);
      await this.connector.sendMessage(userId, outgoing);
    } catch (error) {
      console.error('[Scheduler] Error generating daily summary:', error);
      const errorMessage = `❌ 每日摘要執行失敗：${error}`;
      this.memory.addMessage(userId, 'model', errorMessage);
      await this.connector.sendMessage(userId, errorMessage);
    }
  }
}
