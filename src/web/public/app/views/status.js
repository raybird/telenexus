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
    </div>
  `;

  const refreshBtn = byId(container, '#refreshBtn');
  const statusMsg = byId(container, '#statusMsg');
  const metrics = byId(container, '#metrics');
  const runtime = byId(container, '#runtime');
  const scheduler = byId(container, '#scheduler');
  const provider = byId(container, '#provider');
  const runner = byId(container, '#runner');

  function renderMetrics(st) {
    const providerInfo = st.provider || {};
    const schedulerInfo = st.scheduler || {};
    const runnerInfo = st.runner || {};
    const errorInfo = st.error || {};
    const issues = Array.isArray(errorInfo.recentIssues) ? errorInfo.recentIssues : [];

    const cards = [
      ['Provider', providerInfo.provider || '-'],
      ['Model', providerInfo.model || '-'],
      ['Active Schedules', String(schedulerInfo.activeSchedules || 0)],
      ['Runner Success', runnerInfo.success_rate || '-'],
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
    renderMetrics(data.structured || {});
    statusMsg.textContent = `Updated: ${new Date().toLocaleString('zh-TW')}`;
  }

  const onRefresh = () => void load().catch((e) => (statusMsg.textContent = toErrorMessage(e)));
  scope.on(refreshBtn, 'click', onRefresh);
  void load().catch((e) => (statusMsg.textContent = toErrorMessage(e)));

  return () => scope.destroy();
}
