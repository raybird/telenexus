import { byId } from '../utils/dom.js';
import { toErrorMessage } from '../utils/format.js';
import { createViewScope } from '../utils/view.js';

export function mountStatusView(container, ctx) {
  const scope = createViewScope();
  container.innerHTML = `
    <h2 class="title pad-view">Status</h2>
    <div class="row mb-md">
      <button id="refreshBtn">刷新</button>
      <span class="muted" id="statusMsg"></span>
    </div>

    <div class="grid-4" id="metrics"></div>

    <div class="grid-2 mt-md">
      <section class="col">
        <strong>runtime-status.md</strong>
        <pre id="runtime" class="snapshot"></pre>
      </section>
      <section class="col">
        <strong>scheduler-status.md</strong>
        <pre id="scheduler" class="snapshot"></pre>
      </section>
      <section class="col">
        <strong>provider-status.md</strong>
        <pre id="provider" class="snapshot"></pre>
      </section>
      <section class="col">
        <strong>runner-status.md</strong>
        <pre id="runner" class="snapshot"></pre>
      </section>
      <section class="col">
        <strong>memory-status.md</strong>
        <pre id="memory" class="snapshot"></pre>
      </section>
    </div>

    <section class="col mt-md">
      <strong>Recent Backfill Runs</strong>
      <div id="backfillReport" class="snapshot"></div>
    </section>
  `;

  const refreshBtn = byId(container, '#refreshBtn');
  const statusMsg = byId(container, '#statusMsg');
  const metrics = byId(container, '#metrics');
  const runtime = byId(container, '#runtime');
  const scheduler = byId(container, '#scheduler');
  const provider = byId(container, '#provider');
  const runner = byId(container, '#runner');
  const memory = byId(container, '#memory');
  const backfillReport = byId(container, '#backfillReport');

  function renderBackfillReport(items) {
    if (!Array.isArray(items) || items.length === 0) {
      backfillReport.textContent = '(empty)';
      return;
    }
    backfillReport.textContent = items
      .map((item) => {
        const top = Array.isArray(item.topCandidates)
          ? item.topCandidates
              .slice(0, 2)
              .map((candidate) => `${candidate.type}:${candidate.summary}`)
              .join(' | ')
          : '';
        return [
          `[${item.mode}] ${item.at}`,
          `scanned=${item.scannedSessions} candidates=${item.candidates} written=${item.written} duplicates=${item.duplicatesSkipped}`,
          `checkpoint=${item.checkpointAfter || '(none)'}`,
          top ? `top=${top}` : ''
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
  }

  function renderMetrics(st) {
    const providerInfo = st.provider || {};
    const schedulerInfo = st.scheduler || {};
    const runnerInfo = st.runner || {};
    const memoryInfo = st.memory || {};
    const errorInfo = st.error || {};
    const issues = Array.isArray(errorInfo.recentIssues) ? errorInfo.recentIssues : [];

    const cards = [
      ['Provider', providerInfo.provider || '-'],
      ['Model', providerInfo.model || '-'],
      ['Active Schedules', String(schedulerInfo.activeSchedules || 0)],
      ['Runner Success', runnerInfo.success_rate || '-'],
      ['Archive Sessions', memoryInfo.archive_total_sessions || '-'],
      ['Archive Gap 24h', memoryInfo.archive_estimated_gap_recent_24h || '-'],
      ['Backfill Status', memoryInfo.backfill_last_run_status || '-'],
      ['Backfill Written', memoryInfo.backfill_last_written || '-'],
      ['Recent Errors', String(issues.length)]
    ];
    metrics.innerHTML = '';
    for (const [k, v] of cards) {
      const div = document.createElement('div');
      div.className = 'metric';
      div.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
      metrics.appendChild(div);
    }
  }

  async function load() {
    const data = await ctx.services.status.getStatus();
    runtime.textContent = data.snapshots?.runtime || '(empty)';
    scheduler.textContent = data.snapshots?.scheduler || '(empty)';
    provider.textContent = data.snapshots?.provider || '(empty)';
    runner.textContent = data.snapshots?.runner || '(empty)';
    memory.textContent = data.snapshots?.memory || '(empty)';
    renderMetrics(data.structured || {});
    const report = await ctx.services.status.getBackfillReport(6);
    renderBackfillReport(report.items || []);
    statusMsg.textContent = `Updated: ${new Date().toLocaleString('zh-TW')}`;
  }

  const onRefresh = () => void load().catch((e) => (statusMsg.textContent = toErrorMessage(e)));
  scope.on(refreshBtn, 'click', onRefresh);
  void load().catch((e) => (statusMsg.textContent = toErrorMessage(e)));

  return () => scope.destroy();
}
