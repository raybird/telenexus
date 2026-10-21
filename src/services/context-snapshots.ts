/**
 * 系統狀態快照寫入
 */
import fs from 'fs';
import path from 'path';
import {
  resolveContextDir,
  resolveSchedulerHealthPath,
  resolveModelHealthStatePath
} from '../utils/paths.js';
import { readHealthState } from './model-health-check.js';
import { loadProviderStatus } from '../config/ai-config.js';
import { getRecentIssues, recordRuntimeIssue } from '../utils/errors.js';
import type { MemoryManager } from '../core/memory.js';
import type { MemoriaSyncStatus } from '../core/memoria-sync.js';
import { collectMemoryHealthReport, formatMemoryHealthMarkdown } from './memory-health.js';
import { formatMemoryIntentTraceMarkdown } from './memory-intent-telemetry.js';
import { formatMemoriaStatusMarkdown } from './memoria-status.js';
import { formatPromptSessionTraceMarkdown } from './prompt-session-telemetry.js';

/**
 * 正在失敗的 snapshot。由成功（或程序啟動後第一次）轉為失敗時才記 runtime issue：這裡每 60 秒
 * 與每則訊息都會重算，每次都記的話，要靠 recordRuntimeIssue 的 60 秒 dedupe 而且錯誤訊息
 * 每次都相同才不會洗版；runtime_issue 事件又會讓 event-projector 再排一輪寫入。
 */
const failingSnapshots = new Set<string>();

/**
 * 每個 snapshot 各自計算、各自寫入：任何一個 throw 都只讓它保留上一次的內容，
 * 其他照常更新（issue 0018——先前一個 throw 會讓整輪 10 個檔案都停在舊內容）。
 */
export function writeContextSnapshots(
  memory: MemoryManager,
  options: { memoriaStatus?: MemoriaSyncStatus } = {}
): void {
  const now = new Date();
  let provider: ReturnType<typeof loadProviderStatus> | undefined;
  const getProvider = () => (provider ??= loadProviderStatus());

  const snapshots: Array<[name: string, build: () => string]> = [
    [
      'runtime-status',
      () =>
        [
          '# Runtime Status',
          '',
          `- Updated: ${now.toLocaleString('zh-TW')}`,
          `- Node PID: ${process.pid}`,
          `- NODE_ENV: ${process.env.NODE_ENV || 'unknown'}`,
          `- Provider Config File: ai-config.yaml`,
          `- Active Provider: ${getProvider().provider}`,
          `- Active Model: ${getProvider().model}`,
          `- Timezone (TZ): ${process.env.TZ || 'Asia/Taipei (default)'}`,
          `- Runner Endpoint: ${process.env.RUNNER_ENDPOINT || '(disabled)'}`,
          `- Scheduler Runner Mode: ${process.env.SCHEDULE_USE_RUNNER || 'false'}`,
          `- Chat Runner Percent: ${process.env.CHAT_USE_RUNNER_PERCENT || '0'}`,
          `- Chat Runner Whitelist: ${process.env.CHAT_USE_RUNNER_ONLY_USERS || '(all users)'}`,
          `- Runner Failure Threshold: ${process.env.RUNNER_FAILURE_THRESHOLD || '3'}`,
          `- Runner Cooldown (ms): ${process.env.RUNNER_COOLDOWN_MS || '60000'}`,
          `- DB_PATH: ${process.env.DB_PATH || '(auto-resolved)'}`,
          `- DB_DIR: ${process.env.DB_DIR || '(not set)'}`,
          `- APP_PROJECT_DIR: ${process.env.APP_PROJECT_DIR || process.cwd()}`
        ].join('\n')
    ],
    [
      'provider-status',
      () => {
        const health = readHealthState(resolveModelHealthStatePath());
        const healthLine = health
          ? `${health.status === 'healthy' ? '✅ healthy' : '🚨 failing'}` +
            (health.status === 'failing'
              ? ` (since ${new Date(health.since).toLocaleString('zh-TW')})`
              : '')
          : '(尚未檢查)';

        return [
          '# Provider Status',
          '',
          `- Updated: ${now.toLocaleString('zh-TW')}`,
          `- Provider: ${getProvider().provider}`,
          `- Model: ${getProvider().model}`,
          `- Model Health: ${healthLine}`,
          `- Timezone: ${getProvider().timezone}`
        ].join('\n');
      }
    ],
    [
      'scheduler-status',
      () => {
        const schedules = memory.getActiveSchedules();
        const schedulerLines = schedules.map((schedule) => {
          return `- #${schedule.id} | ${schedule.name} | ${schedule.cron} | user=${schedule.user_id}`;
        });
        return [
          '# Scheduler Status',
          '',
          `- Updated: ${now.toLocaleString('zh-TW')}`,
          `- Active Schedules: ${schedules.length}`,
          '',
          '## Active Schedule List',
          ...(schedulerLines.length > 0 ? schedulerLines : ['- (none)'])
        ].join('\n');
      }
    ],
    [
      'system-architecture',
      () =>
        [
          '# System Architecture Snapshot',
          '',
          '- Input channel: Telegram -> CommandRouter -> Scheduler/Agent',
          '- Scheduler source of truth: SQLite schedules table',
          '- Agent runtime: Opencode CLI executed from workspace/',
          '- Long-term memory: TeleNexus provider-agnostic retrieval before chat dispatch',
          '- Main runtime service: TeleNexus orchestrator'
        ].join('\n')
    ],
    [
      'operations-policy',
      () =>
        [
          '# Operations Policy',
          '',
          '- Read system context from files in workspace/context/',
          '- Do not modify application source code unless explicitly requested by user',
          '- Prefer scheduler commands via Telegram command router',
          '- In Docker, use `docker compose exec telenexus ...` for maintenance commands',
          '- Avoid using one-off `docker compose run` for scheduler modifications'
        ].join('\n')
    ],
    [
      'error-summary',
      () => {
        const recentIssues = getRecentIssues();
        const totalIssueCount = recentIssues.reduce((sum, issue) => sum + (issue.count || 1), 0);
        const recentWindowMs = 15 * 60 * 1000;
        const recentIssueCount = recentIssues
          .filter((issue) => now.getTime() - issue.timestamp <= recentWindowMs)
          .reduce((sum, issue) => sum + (issue.count || 1), 0);
        const scopeCount = new Map<string, number>();
        for (const issue of recentIssues) {
          scopeCount.set(issue.scope, (scopeCount.get(issue.scope) || 0) + (issue.count || 1));
        }
        const topScopeLines = Array.from(scopeCount.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([scope, count]) => `- ${scope}: ${count}`);

        const recentIssueLines = recentIssues
          .slice(-10)
          .map(
            (issue) =>
              `- [${new Date(issue.timestamp).toLocaleString('zh-TW')}] (${issue.scope}) ${issue.message}${issue.count > 1 ? ` (x${issue.count})` : ''}`
          );
        const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
        const persistedByScope = (() => {
          try {
            return memory.countIssuesByScope(dayAgo);
          } catch {
            return [];
          }
        })();
        const rateLimit24h =
          persistedByScope
            .filter((row) => row.scope === 'opencode:rate-limit')
            .reduce((sum, row) => sum + row.count, 0) ?? 0;
        const persistedScopeLines = persistedByScope
          .slice(0, 10)
          .map((row) => `- ${row.scope}: ${row.count}`);

        return [
          '# Error Summary',
          '',
          `- Updated: ${now.toLocaleString('zh-TW')}`,
          `- Total Runtime Issues (buffered): ${totalIssueCount}`,
          `- Recent 15m Issues: ${recentIssueCount}`,
          `- Rate-limit Issues (24h): ${rateLimit24h}`,
          '',
          '## Top Scopes',
          ...(topScopeLines.length > 0 ? topScopeLines : ['- (none)']),
          '',
          '## Past 24h by Scope (persisted)',
          ...(persistedScopeLines.length > 0 ? persistedScopeLines : ['- (none)']),
          '',
          '## Recent Runtime Issues',
          ...(recentIssueLines.length > 0 ? recentIssueLines : ['- (none)'])
        ].join('\n');
      }
    ],
    ['memory-status', () => formatMemoryHealthMarkdown(collectMemoryHealthReport())],
    [
      'memoria-status',
      () =>
        options.memoriaStatus
          ? formatMemoriaStatusMarkdown(options.memoriaStatus)
          : formatMemoriaStatusMarkdown({
              mode: 'off',
              available: false,
              disabled: true,
              endpointReachable: false,
              endpoint: '(unknown)',
              hookQueueEnabled: false,
              hookQueuePollMs: 0,
              recentFailureCount: 0,
              lastSyncAt: null,
              lastFailureAt: null,
              lastFailureMessage: null
            })
    ],
    ['memory-intent-status', formatMemoryIntentTraceMarkdown],
    ['prompt-session-status', formatPromptSessionTraceMarkdown]
  ];

  for (const [name, build] of snapshots) {
    try {
      // 目錄的解析與建立也放在這裡：失敗時和其他錯誤一樣逐檔回報，而不是 throw 給呼叫端
      const contextDir = resolveContextDir();
      fs.mkdirSync(contextDir, { recursive: true });
      fs.writeFileSync(path.join(contextDir, `${name}.md`), build(), 'utf8');
      if (failingSnapshots.delete(name)) {
        console.log(`[System] Context snapshot ${name} 已恢復更新`);
      }
    } catch (error) {
      console.warn(`[System] Failed to write context snapshot ${name}:`, error);
      if (!failingSnapshots.has(name)) {
        failingSnapshots.add(name);
        recordRuntimeIssue(`context-snapshot:${name}`, error);
      }
    }
  }
}

export function writeSchedulerHealth(trigger: string, memory: MemoryManager): void {
  try {
    const healthPath = resolveSchedulerHealthPath();
    const payload = {
      updatedAt: Date.now(),
      lastReloadAt: Date.now(),
      lastLoadedScheduleCount: memory.getActiveSchedules().length,
      trigger,
      pid: process.pid
    };

    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    fs.writeFileSync(healthPath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.warn('[System] Failed to write scheduler health marker:', error);
  }
}
