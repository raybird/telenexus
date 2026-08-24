import { Cron } from 'croner';
import { MemoryManager, type Schedule } from './memory.js';
import fs from 'fs';
import yaml from 'js-yaml';
import type { AIAgent } from './agent.js';
import { executionQueue } from './execution-queue.js';
import {
  assessAiResponse,
  buildDailySummaryPrompt,
  buildMemoryContextLines,
  buildReflectionPrompt,
  buildScheduledTaskPrompt,
  extractKeywords,
  fingerprintReflection,
  hasUserActivitySinceLastReflection,
  truncateInline
} from './scheduler-helpers.js';
import { createLogger } from './logger.js';
import type { Connector } from '../types/index.js';
import { inferSummaryMetadata } from './summary-metadata.js';
import type { MemoriaSyncTurn } from './memoria-sync.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { emitEvent } from '../services/event-bus.js';

const log = createLogger('scheduler');

const DEFAULT_SCHEDULE_TASK_TIMEOUT_MS = 30 * 60 * 1000;

function readScheduleTaskTimeoutMs(): number {
  const raw = process.env.SCHEDULE_TASK_TIMEOUT_MS;
  if (!raw) return DEFAULT_SCHEDULE_TASK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 30_000) {
    return DEFAULT_SCHEDULE_TASK_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * 排程層 timeout,並在逾時當下真的把底層工作取消掉。
 *
 * ⚠️ 修正前這裡只 reject 上層 Promise:queue task 沒被通知、Opencode 子程序繼續跑到自然結束、
 * agent-browser 與 Chrome 整棵樹留著,同一個 user 的序列 queue 也被繼續佔住。實務後果是
 * 逾時的工作與它的重試同時在吃 provider 配額,429 因此連環出現。
 *
 * 傳給 `fn` 的 signal 有兩個作用,缺一不可:
 *   - 工作**執行中**逾時 → abort 一路傳到 `runProcess`,終止整個 process group
 *   - 工作**還在排隊**時逾時 → 輪到它時呼叫端看到 aborted 就直接放棄,不會再送一次進 Opencode
 *
 * 刻意不用 `executionQueue.cancel(userId)`:那會連同該 user 排隊中的互動訊息一起清掉,
 * 排程逾時不該波及使用者當下的對話。
 */
function withScheduleTimeout<T>(
  label: string,
  scheduleId: number,
  fn: (timeoutSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = readScheduleTaskTimeoutMs();
  const ac = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ac.abort();
      reject(
        new Error(`Schedule task '${label}' (id=${scheduleId}) exceeded ${timeoutMs}ms timeout`)
      );
    }, timeoutMs);
    timer.unref?.();
    fn(ac.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class Scheduler {
  private jobs: Map<number, Cron> = new Map();
  private systemJobs: Map<string, Cron> = new Map();
  private silenceTimers: Map<string, NodeJS.Timeout> = new Map();
  private silenceTimerSeq: Map<string, number> = new Map();
  private lastReflectionFingerprint: Map<string, string> = new Map();
  private readonly SILENCE_TIMEOUT_MS = 30 * 60 * 1000; // 正式環境：30 分鐘
  private memory: MemoryManager;
  private taskAgent: AIAgent;
  private connector: Connector;
  private enqueueMemoriaSync: ((turn: MemoriaSyncTurn) => void) | undefined;

  constructor(
    memory: MemoryManager,
    taskAgent: AIAgent,
    connector: Connector,
    enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void
  ) {
    this.memory = memory;
    this.taskAgent = taskAgent;
    this.connector = connector;
    this.enqueueMemoriaSync = enqueueMemoriaSync;
  }

  private persistSchedulerMessage(
    userId: string,
    syntheticUserMessage: string,
    modelMessage: string,
    options?: { forceNewSession?: boolean }
  ): void {
    this.memory.addMessage(userId, 'model', modelMessage, inferSummaryMetadata(modelMessage));
    this.enqueueMemoriaSync?.({
      userId,
      userMessage: syntheticUserMessage,
      modelMessage,
      platform: 'scheduler',
      isPassthroughCommand: false,
      forceNewSession: options?.forceNewSession === true
    });
  }

  private clearSilenceTimer(userId: string): void {
    const timer = this.silenceTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(userId);
      log.info('silence-timer.cleared', { userId });
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
        log.info('silence-timer.stale-skipped', { userId, seq: nextSeq, activeSeq });
        return;
      }

      log.info('silence-timer.fired', { userId, seq: nextSeq, source });
      await this.triggerReflection(userId, 'silence', undefined, nextSeq);
    }, delayMs);

    this.silenceTimers.set(userId, timer);
    log.info('silence-timer.scheduled', {
      userId,
      seq: nextSeq,
      source,
      delayMs,
      activeTimers: this.silenceTimers.size
    });
  }

  private hasUserActivitySinceLastReflection(userId: string): boolean {
    return hasUserActivitySinceLastReflection(this.memory.getExtendedHistory(userId, 24));
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
        const config = yaml.load(fileContent) as Record<string, unknown> | undefined;
        const tz = config?.timezone;
        return typeof tz === 'string' ? tz : 'Asia/Taipei';
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
    log.info('init.active-schedules-loaded', { count: schedules.length });

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
      log.info('startup-activity.skipped', { reason: 'missing_allowed_user' });
      return;
    }

    const lastMessageTime = this.memory.getLastMessageTime(userId);
    const now = Date.now();

    if (lastMessageTime === null) {
      // 資料庫沒有任何訊息紀錄，發送問候訊息
      log.info('startup-activity.greeting-sent', { userId });
      await this.connector.sendMessage(
        userId,
        '👋 嗨！我是 TeleNexus，您的 AI 助理。有什麼需要幫忙的嗎？'
      );
      this.resetSilenceTimer(userId);
    } else {
      const silenceMs = now - lastMessageTime;
      const silenceMinutes = Math.floor(silenceMs / 1000 / 60);
      log.info('startup-activity.last-message-age', { userId, silenceMinutes });

      if (silenceMs >= this.SILENCE_TIMEOUT_MS) {
        // 超過沉默時間，立即觸發追蹤
        log.info('startup-activity.followup-triggered', { userId, reason: 'silence_exceeded' });
        await this.triggerReflection(userId, 'silence');
      } else {
        // 尚未超過，設定剩餘時間的計時器
        const remainingMs = this.SILENCE_TIMEOUT_MS - silenceMs;
        log.info('startup-activity.followup-scheduled', {
          userId,
          remainingMinutes: Math.floor(remainingMs / 1000 / 60)
        });
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
      log.info('system-job.daily-summary.triggered');
      await this.executeDailySummary();
    });
    this.systemJobs.set('daily_summary', dailySummaryJob);
    log.info('system-job.daily-summary.registered', { timezone });
  }

  /**
   * 啟動一個 cron 任務
   * @param schedule 排程資料
   */
  private startJob(schedule: Schedule): void {
    // 如果已存在相同 ID 的 Job，先停止它（避免重複掛載）
    if (this.jobs.has(schedule.id)) {
      log.info('job.duplicate-stopped', { scheduleId: schedule.id });
      this.jobs.get(schedule.id)?.stop();
      this.jobs.delete(schedule.id);
    }

    try {
      const timezone = this.getTimezone();
      const job = new Cron(schedule.cron, { timezone }, async () => {
        log.info('job.triggered', { scheduleId: schedule.id, name: schedule.name });
        await this.executeTask(schedule);
      });

      this.jobs.set(schedule.id, job);
      log.info('job.started', {
        scheduleId: schedule.id,
        name: schedule.name,
        cron: schedule.cron,
        timezone
      });
    } catch (error) {
      log.error('job.start-failed', { scheduleId: schedule.id, name: schedule.name, error });
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

  /**
   * 從 TeleNexus 內建記憶檢索長期上下文（不依賴 provider hook）
   */
  private async retrieveLongTermMemory(userId: string, prompt: string): Promise<string> {
    try {
      const recent = this.memory.getRecentMessages(userId, 80);
      if (recent.length === 0) {
        return '';
      }

      const keywords = extractKeywords(prompt);
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

      const lines = buildMemoryContextLines(matches);

      const context = ['【記憶參考（TeleNexus）】', ...lines].join('\n');
      log.info('memory-context.retrieved', {
        userId,
        lines: lines.length,
        keywords: loweredKeywords.length
      });
      return context;
    } catch (error) {
      log.error('memory-context.retrieve-failed', { userId, error });
      return '';
    }
  }

  /**
   * 排程輪次實際送進 Opencode 的那一步,把兩個取消來源合成一條鏈。
   *
   * `timeoutSignal` 來自 withScheduleTimeout(排程層逾時),`queueSignal` 來自 ExecutionQueue
   * (使用者 /abort 或佇列取消)。任一觸發都要能終止底層 CLI 與它長出來的 browser tree。
   *
   * 開頭的 aborted 檢查處理的是「排隊期間就已逾時」:序列佇列前面還有工作時,後面這筆可能
   * 在還沒開始執行就先撞到上層 timeout。少了這道檢查,它仍會被 drain 取出照跑一遍 ——
   * 上層早已 reject、沒有人在等它的結果,但配額照吃。
   */
  private async runScheduledChat(
    prompt: string,
    timeoutSignal: AbortSignal,
    queueSignal: AbortSignal
  ): Promise<string> {
    if (timeoutSignal.aborted) {
      throw new Error('Scheduled task aborted before execution (timed out while queued)');
    }
    return this.taskAgent.chat(prompt, {
      forceNewSession: true,
      fromScheduler: true,
      signal: AbortSignal.any([timeoutSignal, queueSignal])
    });
  }

  /**
   * 執行排程任務
   */
  private async executeTask(schedule: Schedule): Promise<void> {
    emitEvent('schedule_fire', { scheduleId: schedule.id, name: schedule.name });
    try {
      // 1. 檢索長期記憶 (MCP Memory)
      const longTermMemory = await this.retrieveLongTermMemory(schedule.user_id, schedule.prompt);

      // 2. 組合 Prompt
      const fullPrompt = buildScheduledTaskPrompt(schedule.name, schedule.prompt, longTermMemory);

      // 3. 呼叫 Opencode CLI（套用 schedule-level timeout 防止下游卡死）
      let response = await withScheduleTimeout(schedule.name, schedule.id, (timeoutSignal) =>
        executionQueue.enqueue(schedule.user_id, 'scheduler-task', 'low', ({ signal }) =>
          this.runScheduledChat(fullPrompt, timeoutSignal, signal)
        )
      );
      const firstAssessment = assessAiResponse(response);
      if (firstAssessment.shouldRetry) {
        log.warn('task.retrying', { scheduleId: schedule.id, reason: firstAssessment.reason });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        response = await withScheduleTimeout(schedule.name, schedule.id, (timeoutSignal) =>
          executionQueue.enqueue(schedule.user_id, 'scheduler-task-retry', 'low', ({ signal }) =>
            this.runScheduledChat(fullPrompt, timeoutSignal, signal)
          )
        );
        const secondAssessment = assessAiResponse(response);
        if (secondAssessment.shouldRetry) {
          throw new Error(
            `AI returned incomplete execution response after retry (${secondAssessment.reason})`
          );
        }
      }
      log.info('task.completed', { scheduleId: schedule.id, responseLength: response.length });
      emitEvent('schedule_done', {
        scheduleId: schedule.id,
        name: schedule.name,
        responseLength: response.length
      });

      // 4. 儲存 AI 回應到記憶
      if (response && !response.startsWith('Error')) {
        this.persistSchedulerMessage(
          schedule.user_id,
          `[排程任務] ${schedule.name}: ${schedule.prompt}`,
          response,
          { forceNewSession: true }
        );
      }

      // 5. 將結果傳送給使用者
      const messageHeader = `🕐 [排程: ${schedule.name}]\n\n`;
      await this.connector.sendMessage(schedule.user_id, messageHeader + response);
    } catch (error) {
      log.error('task.failed', { scheduleId: schedule.id, name: schedule.name, error });
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = /exceeded\s+\d+ms\s+timeout/.test(message);
      recordRuntimeIssue(isTimeout ? 'scheduler:task-timeout' : 'scheduler:task-failed', error);
      emitEvent('schedule_fail', {
        scheduleId: schedule.id,
        name: schedule.name,
        isTimeout,
        message
      });
      const errorMessage = isTimeout
        ? `⏱️ 排程任務 "${schedule.name}" 逾時自動中止（${message}）`
        : `❌ 排程任務 "${schedule.name}" 執行失敗：${error}`;
      this.persistSchedulerMessage(
        schedule.user_id,
        `[排程任務失敗] ${schedule.name}: ${schedule.prompt}`,
        errorMessage,
        { forceNewSession: true }
      );
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

    log.info('schedule.updated', { scheduleId: id, userId });
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
    log.info('schedule.removed', { scheduleId: id });
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
    log.info('shutdown.started', { jobs: this.jobs.size, systemJobs: this.systemJobs.size });
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
      log.info('shutdown.job-stopped', { scheduleId: id });
    }
    this.jobs.clear();

    // 停止系統排程
    for (const [name, job] of this.systemJobs.entries()) {
      job.stop();
      log.info('shutdown.system-job-stopped', { name });
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
    log.info('reload.started');

    // 停止所有使用者排程（保留系統排程）
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
      log.info('reload.job-stopped', { scheduleId: id });
    }
    this.jobs.clear();

    // 重新載入啟用的排程
    const schedules = this.memory.getActiveSchedules();
    log.info('reload.active-schedules-loaded', { count: schedules.length });

    for (const schedule of schedules) {
      this.startJob(schedule);
    }

    log.info('reload.completed');
  }

  /**
   * 重置使用者的沉默計時器 (每次收到訊息時呼叫)
   */
  resetSilenceTimer(userId: string): void {
    log.info('silence-timer.reset', {
      userId,
      nextTriggerMinutes: this.SILENCE_TIMEOUT_MS / 1000 / 60
    });
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
    log.info('reflection.triggered', { userId, type, sourceTimerSeq: sourceTimerSeq ?? 'n/a' });

    try {
      if (type === 'silence' && !this.hasUserActivitySinceLastReflection(userId)) {
        log.info('reflection.skipped.no-new-activity', { userId });
        return;
      }

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
          return `[${time}] User: ${truncateInline(msg.content, 500)}`;
        })
        .join('\n\n');

      // 格式化模型歷史（次要上下文），僅取最近 12 筆避免雜訊
      const modelHistoryText = modelHistory
        .slice(-12)
        .map((msg) => {
          const time = new Date(msg.timestamp).toLocaleString('zh-TW');
          return `[${time}] AI: ${truncateInline(msg.content, 500)}`;
        })
        .join('\n\n');

      // 檢索長期記憶
      const longTermMemory = await this.retrieveLongTermMemory(userId, '對話回顧 追蹤 待辦');

      // 組合追蹤提醒 Prompt
      const reflectionPrompt = buildReflectionPrompt(
        userHistoryText,
        modelHistoryText,
        longTermMemory
      );

      const response = await executionQueue.enqueue(userId, 'scheduler-reflection', 'low', () =>
        this.taskAgent.chat(reflectionPrompt)
      );
      const hasNoAction = !response || response.includes('無待處理事項');
      const currentFingerprint = fingerprintReflection(response || '');
      const previousFingerprint = this.lastReflectionFingerprint.get(userId);
      const isRepeatedReflection =
        !hasNoAction && Boolean(previousFingerprint) && previousFingerprint === currentFingerprint;

      if (isRepeatedReflection) {
        const checkedMsg = '✅ [追蹤檢查] 已完成檢查，目前沒有新的事項變化。';
        this.persistSchedulerMessage(userId, `[追蹤檢查] type=${type}`, checkedMsg, {
          forceNewSession: true
        });
        if (type === 'manual' && messageIdToEdit) {
          await this.connector.editMessage(userId, messageIdToEdit, checkedMsg);
        } else {
          await this.connector.sendMessage(userId, checkedMsg);
        }
      } else if (!hasNoAction) {
        const header = type === 'silence' ? '🔔 [追蹤提醒]\n\n' : '🔍 [手動追蹤]\n\n';
        const outgoing = header + response;
        this.persistSchedulerMessage(userId, `[追蹤提醒] type=${type}`, outgoing, {
          forceNewSession: true
        });

        if (messageIdToEdit) {
          await this.connector.editMessage(userId, messageIdToEdit, outgoing);
        } else {
          await this.connector.sendMessage(userId, outgoing);
        }

        this.lastReflectionFingerprint.set(userId, currentFingerprint);
      } else {
        log.info('reflection.completed.no-action', { userId, type });
        const noTodoMsg = '✨ 無待辦。';
        this.persistSchedulerMessage(userId, `[追蹤檢查] type=${type}`, noTodoMsg, {
          forceNewSession: true
        });
        // 沉默模式也發送精簡通知
        if (type === 'silence') {
          await this.connector.sendMessage(userId, noTodoMsg);
        } else if (type === 'manual' && messageIdToEdit) {
          await this.connector.editMessage(userId, messageIdToEdit, noTodoMsg);
        }
      }
    } catch (error) {
      log.error('reflection.failed', { userId, type, error });
      const errorMessage = `❌ 追蹤提醒執行失敗：${error}`;
      this.persistSchedulerMessage(userId, `[追蹤提醒失敗] type=${type}`, errorMessage, {
        forceNewSession: true
      });
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
          log.info('reflection.reschedule.skipped-stale', {
            userId,
            sourceTimerSeq,
            activeSeq
          });
          return;
        }
      }

      log.info('reflection.reschedule', {
        userId,
        delayMinutes: this.SILENCE_TIMEOUT_MS / 1000 / 60
      });
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
      log.info('daily-summary.skipped', { reason: 'missing_allowed_user' });
      return;
    }

    log.info('daily-summary.generating', { userId });

    try {
      const summaryPrompt = buildDailySummaryPrompt(new Date().toLocaleDateString('zh-TW'));

      const response = await executionQueue.enqueue(userId, 'scheduler-daily-summary', 'low', () =>
        this.taskAgent.chat(summaryPrompt, { forceNewSession: true })
      );
      const outgoing = '📅 [每日摘要]\n\n' + response;
      this.persistSchedulerMessage(userId, '[每日摘要] 生成當日摘要', outgoing, {
        forceNewSession: true
      });
      await this.connector.sendMessage(userId, outgoing);
    } catch (error) {
      log.error('daily-summary.failed', { userId, error });
      const errorMessage = `❌ 每日摘要執行失敗：${error}`;
      this.persistSchedulerMessage(userId, '[每日摘要失敗] 生成當日摘要', errorMessage, {
        forceNewSession: true
      });
      await this.connector.sendMessage(userId, errorMessage);
    }
  }
}
