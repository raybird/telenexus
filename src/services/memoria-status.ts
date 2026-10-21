import type { MemoriaSyncStatus } from '../core/memoria-sync.js';
import type { MemoriaRecallVersionSummary } from '../core/memory.js';
import { formatMemoriaRecallTelemetryMarkdown } from './memoria-recall-telemetry.js';

/** 成功次數少於這個值時，比例標成不可判定（issue 0020）。 */
const MIN_RECALL_SAMPLES = 20;

export type RecallMetricsSource = {
  currentVersion: string;
  read: () => MemoriaRecallVersionSummary[];
};

export function formatMemoriaStatusMarkdown(
  status: MemoriaSyncStatus,
  options: { recallMetrics?: RecallMetricsSource } = {}
): string {
  return [
    '# Memoria Status',
    '',
    '## Sync Bridge',
    '',
    `- Mode: ${status.mode}`,
    `- Available: ${status.available ? 'yes' : 'no'}`,
    `- Disabled: ${status.disabled ? 'yes' : 'no'}`,
    `- Endpoint Reachable: ${status.endpointReachable ? 'yes' : 'no'}`,
    `- Endpoint: ${status.endpoint}`,
    `- Hook Queue Enabled: ${status.hookQueueEnabled ? 'yes' : 'no'}`,
    `- Hook Queue Poll (ms): ${status.hookQueuePollMs}`,
    `- Recent Failure Count: ${status.recentFailureCount}`,
    `- Last Sync At: ${status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('zh-TW') : '(none)'}`,
    `- Last Failure At: ${status.lastFailureAt ? new Date(status.lastFailureAt).toLocaleString('zh-TW') : '(none)'}`,
    `- Last Failure Message: ${status.lastFailureMessage || '(none)'}`,
    '',
    formatMemoriaRecallTelemetryMarkdown(),
    ...(options.recallMetrics
      ? [
          '',
          formatRecallMetricsByVersionMarkdown(
            options.recallMetrics.currentVersion,
            options.recallMetrics.read
          )
        ]
      : [])
  ].join('\n');
}

/**
 * 依版本彙總的聊天召回指標（issue 0020）。上面的 Recall Telemetry 只有記憶體裡最近 50 筆、
 * 重啟就歸零；這一節讀 moltbot.db，用來比較升級前後。讀取失敗時標示原因，不 throw。
 */
export function formatRecallMetricsByVersionMarkdown(
  currentVersion: string,
  read: () => MemoriaRecallVersionSummary[]
): string {
  const header = ['## Recall Metrics by Version', ''];
  let rows: MemoriaRecallVersionSummary[];
  try {
    rows = read();
  } catch (err) {
    return [
      ...header,
      '- Status: error',
      `- Detail: ${err instanceof Error ? err.message : String(err)}`
    ].join('\n');
  }

  const current = rows.find((row) => row.version === currentVersion);
  // rows 依最後一筆的時間由新到舊排列，第一個不是目前版本的就是最近的前一版
  const previous = rows.find((row) => row.version !== currentVersion);

  return [
    ...header,
    `- 保留 30 天；比例只計成功的召回，成功少於 ${MIN_RECALL_SAMPLES} 次時顯示 unknown`,
    '',
    `### Current Version: ${currentVersion}`,
    ...(current ? formatVersionLines(current) : ['- (尚無樣本)']),
    '',
    previous ? `### Previous Version: ${previous.version}` : '### Previous Version',
    ...(previous ? formatVersionLines(previous) : ['- (保留期內沒有其他版本的資料)'])
  ].join('\n');
}

function formatVersionLines(row: MemoriaRecallVersionSummary): string[] {
  const rate = (count: number): string =>
    row.succeeded < MIN_RECALL_SAMPLES
      ? `unknown（樣本不足，n=${row.succeeded}）`
      : `${((count / row.succeeded) * 100).toFixed(1)}% (${count}/${row.succeeded})`;
  return [
    `- Recalls: ${row.total}（成功 ${row.succeeded}、失敗 ${row.total - row.succeeded}）`,
    `- First / Last: ${new Date(row.firstAt).toLocaleString('zh-TW')} / ${new Date(row.lastAt).toLocaleString('zh-TW')}`,
    `- Hit Rate: ${rate(row.withHits)}`,
    `- Injected Rate: ${rate(row.injected)}`,
    `- Degraded Rate: ${rate(row.degraded)}`
  ];
}
