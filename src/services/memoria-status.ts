import type { MemoriaSyncStatus } from '../core/memoria-sync.js';

export function formatMemoriaStatusMarkdown(status: MemoriaSyncStatus): string {
  return [
    '# Memoria Status',
    '',
    `- Mode: ${status.mode}`,
    `- Available: ${status.available ? 'yes' : 'no'}`,
    `- Disabled: ${status.disabled ? 'yes' : 'no'}`,
    `- CLI Detected: ${status.cliDetected ? 'yes' : 'no'}`,
    `- Memoria Home: ${status.memoriaHome}`,
    `- CLI Path: ${status.cliPath}`,
    `- Hook Queue Enabled: ${status.hookQueueEnabled ? 'yes' : 'no'}`,
    `- Hook Queue Poll (ms): ${status.hookQueuePollMs}`,
    `- Recent Failure Count: ${status.recentFailureCount}`,
    `- Last Sync At: ${status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('zh-TW') : '(none)'}`,
    `- Last Failure At: ${status.lastFailureAt ? new Date(status.lastFailureAt).toLocaleString('zh-TW') : '(none)'}`,
    `- Last Failure Message: ${status.lastFailureMessage || '(none)'}`
  ].join('\n');
}
