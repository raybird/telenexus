/**
 * 系統狀態快照寫入
 */
import fs from 'fs';
import path from 'path';
import { resolveContextDir, resolveSchedulerHealthPath } from '../utils/paths.js';
import { loadProviderStatus } from '../config/ai-config.js';
import { getRecentIssues } from '../utils/errors.js';
import type { MemoryManager } from '../core/memory.js';
import type { MemoriaSyncStatus } from '../core/memoria-sync.js';
import { collectMemoryHealthReport, formatMemoryHealthMarkdown } from './memory-health.js';
import { formatMemoryIntentTraceMarkdown } from './memory-intent-telemetry.js';
import { formatMemoriaStatusMarkdown } from './memoria-status.js';
import { formatPromptSessionTraceMarkdown } from './prompt-session-telemetry.js';

export function writeContextSnapshots(
  memory: MemoryManager,
  options: { memoriaStatus?: MemoriaSyncStatus } = {}
): void {
  try {
    const contextDir = resolveContextDir();
    fs.mkdirSync(contextDir, { recursive: true });

    const now = new Date();
    const provider = loadProviderStatus();
    const runtimeStatus = [
      '# Runtime Status',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      `- Node PID: ${process.pid}`,
      `- NODE_ENV: ${process.env.NODE_ENV || 'unknown'}`,
      `- Provider Config File: ai-config.yaml`,
      `- Active Provider: ${provider.provider}`,
      `- Active Model: ${provider.model}`,
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
    ].join('\n');

    const providerStatus = [
      '# Provider Status',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      `- Provider: ${provider.provider}`,
      `- Model: ${provider.model}`,
      `- Timezone: ${provider.timezone}`
    ].join('\n');

    const schedules = memory.getActiveSchedules();
    const schedulerLines = schedules.map((schedule) => {
      return `- #${schedule.id} | ${schedule.name} | ${schedule.cron} | user=${schedule.user_id}`;
    });
    const schedulerStatus = [
      '# Scheduler Status',
      '',
      `- Updated: ${now.toLocaleString('zh-TW')}`,
      `- Active Schedules: ${schedules.length}`,
      '',
      '## Active Schedule List',
      ...(schedulerLines.length > 0 ? schedulerLines : ['- (none)'])
    ].join('\n');

    const systemArchitecture = [
      '# System Architecture Snapshot',
      '',
      '- Input channel: Telegram -> CommandRouter -> Scheduler/Agent',
      '- Scheduler source of truth: SQLite schedules table',
      '- Agent runtime: Opencode CLI executed from workspace/',
      '- Long-term memory: TeleNexus provider-agnostic retrieval before chat dispatch',
      '- Main runtime service: TeleNexus orchestrator'
    ].join('\n');

    const operationsPolicy = [
      '# Operations Policy',
      '',
      '- Read system context from files in workspace/context/',
      '- Do not modify application source code unless explicitly requested by user',
      '- Prefer scheduler commands via Telegram command router',
      '- In Docker, use `docker compose exec telenexus ...` for maintenance commands',
      '- Avoid using one-off `docker compose run` for scheduler modifications'
    ].join('\n');

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

    const errorSummary = [
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

    const memoryStatus = formatMemoryHealthMarkdown(collectMemoryHealthReport());
    const memoriaStatus = options.memoriaStatus
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
        });
    const memoryIntentStatus = formatMemoryIntentTraceMarkdown();
    const promptSessionStatus = formatPromptSessionTraceMarkdown();

    fs.writeFileSync(path.join(contextDir, 'runtime-status.md'), runtimeStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'provider-status.md'), providerStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'scheduler-status.md'), schedulerStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'system-architecture.md'), systemArchitecture, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'operations-policy.md'), operationsPolicy, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'error-summary.md'), errorSummary, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'memory-status.md'), memoryStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'memoria-status.md'), memoriaStatus, 'utf8');
    fs.writeFileSync(path.join(contextDir, 'memory-intent-status.md'), memoryIntentStatus, 'utf8');
    fs.writeFileSync(
      path.join(contextDir, 'prompt-session-status.md'),
      promptSessionStatus,
      'utf8'
    );
  } catch (error) {
    console.warn('[System] Failed to write context snapshots:', error);
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
