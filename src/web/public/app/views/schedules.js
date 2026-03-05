import { byId } from '../utils/dom.js';
import { escapeHtml, toErrorMessage } from '../utils/format.js';
import { renderList, setListError } from '../utils/list.js';
import { createViewScope } from '../utils/view.js';

function renderScheduleList(container, items) {
  renderList(
    container,
    items,
    (item) => {
      const active = item.is_active ? 'active' : 'inactive';
      const toggleLabel = item.is_active ? '停用' : '啟用';
      return `
        <div class="muted">#${item.id} | ${active}</div>
        <div>${escapeHtml(item.name)}</div>
        <div class="muted">${escapeHtml(item.cron)}</div>
        <div class="row mt-sm">
          <button data-action="edit" data-id="${item.id}">編輯</button>
          <button data-action="toggle" data-id="${item.id}" data-active="${item.is_active ? '1' : '0'}">${toggleLabel}</button>
          <button data-action="remove" data-id="${item.id}">刪除</button>
        </div>
      `;
    },
    { emptyText: '(none)' }
  );
}

export function mountSchedulesView(container, ctx) {
  const scope = createViewScope();
  container.innerHTML = `
    <h2 class="title pad-view">Schedules</h2>
    <section class="col">
      <div class="row">
        <input id="nameInput" placeholder="排程名稱" class="flex-1" />
        <input id="cronInput" placeholder="Cron (5 欄位)" class="flex-1" />
      </div>
      <textarea id="promptInput" placeholder="排程提示詞" rows="4"></textarea>
      <div class="row">
        <button id="addBtn">新增排程</button>
        <button id="reloadBtn">Reload</button>
        <button id="reflectBtn">手動追蹤分析</button>
        <span class="muted" id="scheduleStatus"></span>
      </div>
    </section>

    <section class="col mt-md">
      <div class="row">
        <strong>Schedule List</strong>
        <button id="refreshBtn">刷新</button>
      </div>
      <div id="scheduleList" class="list"></div>
    </section>
  `;

  const nameInput = byId(container, '#nameInput');
  const cronInput = byId(container, '#cronInput');
  const promptInput = byId(container, '#promptInput');
  const addBtn = byId(container, '#addBtn');
  const reloadBtn = byId(container, '#reloadBtn');
  const reflectBtn = byId(container, '#reflectBtn');
  const refreshBtn = byId(container, '#refreshBtn');
  const list = byId(container, '#scheduleList');
  const status = byId(container, '#scheduleStatus');

  let currentItems = [];

  async function loadSchedules() {
    const data = await ctx.services.schedules.getAll();
    currentItems = Array.isArray(data.items) ? data.items : [];
    renderScheduleList(list, currentItems);
  }

  async function createSchedule() {
    const name = (nameInput.value || '').trim();
    const cron = (cronInput.value || '').trim();
    const prompt = (promptInput.value || '').trim();
    if (!name || !cron || !prompt) {
      status.textContent = '請填寫名稱、cron、提示詞';
      return;
    }
    status.textContent = '新增中...';
    await ctx.services.schedules.create({ name, cron, prompt });
    nameInput.value = '';
    cronInput.value = '';
    promptInput.value = '';
    status.textContent = '已新增';
    await loadSchedules();
  }

  async function editSchedule(id) {
    const target = currentItems.find((it) => String(it.id) === String(id));
    if (!target) return;
    const name = window.prompt('排程名稱', target.name || '');
    if (name === null) return;
    const cron = window.prompt('Cron（5 欄位）', target.cron || '');
    if (cron === null) return;
    const prompt = window.prompt('排程提示詞', target.prompt || '');
    if (prompt === null) return;

    status.textContent = '更新中...';
    await ctx.services.schedules.update(id, {
      name: name.trim(),
      cron: cron.trim(),
      prompt: prompt.trim()
    });
    status.textContent = '已更新';
    await loadSchedules();
  }

  async function toggleSchedule(id, activeFlag) {
    const nextActive = activeFlag !== '1';
    status.textContent = '更新狀態中...';
    await ctx.services.schedules.toggle(id, nextActive);
    status.textContent = '狀態已更新';
    await loadSchedules();
  }

  async function removeSchedule(id) {
    if (!window.confirm(`確定刪除排程 #${id} ?`)) return;
    status.textContent = '刪除中...';
    await ctx.services.schedules.remove(id);
    status.textContent = '已刪除';
    await loadSchedules();
  }

  async function reloadSchedules() {
    status.textContent = 'Reload 中...';
    await ctx.services.schedules.reload();
    status.textContent = '已 reload';
    await loadSchedules();
  }

  async function triggerReflect() {
    status.textContent = '觸發追蹤分析中...';
    await ctx.services.schedules.triggerReflect();
    status.textContent = '已觸發';
  }

  const onRefresh = () => void loadSchedules().catch((e) => setListError(list, e));
  const onAdd = () => void createSchedule().catch((e) => (status.textContent = toErrorMessage(e)));
  const onReload = () =>
    void reloadSchedules().catch((e) => (status.textContent = toErrorMessage(e)));
  const onReflect = () =>
    void triggerReflect().catch((e) => (status.textContent = toErrorMessage(e)));
  const onListClick = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest('button[data-action]');
    if (!(btn instanceof HTMLButtonElement)) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (!action || !id) return;
    if (action === 'edit') {
      void editSchedule(id).catch((e) => (status.textContent = toErrorMessage(e)));
    } else if (action === 'toggle') {
      void toggleSchedule(id, btn.dataset.active || '0').catch(
        (e) => (status.textContent = toErrorMessage(e))
      );
    } else if (action === 'remove') {
      void removeSchedule(id).catch((e) => (status.textContent = toErrorMessage(e)));
    }
  };

  scope.on(refreshBtn, 'click', onRefresh);
  scope.on(addBtn, 'click', onAdd);
  scope.on(reloadBtn, 'click', onReload);
  scope.on(reflectBtn, 'click', onReflect);
  scope.on(list, 'click', onListClick);

  void loadSchedules().catch((e) => setListError(list, e));

  return () => scope.destroy();
}
