import { byId } from '../utils/dom.js';
import { escapeHtml, formatTimestamp } from '../utils/format.js';
import { setListError } from '../utils/list.js';
import { renderMarkdownToHtml } from '../utils/markdown.js';
import { createViewScope } from '../utils/view.js';

function renderEmptyState(container, text) {
  container.innerHTML = `<div class="item">${escapeHtml(text)}</div>`;
}

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function toConversationOrder(items) {
  if (!Array.isArray(items)) return [];
  if (items.length <= 1) return items;

  const firstTs = Number(items[0]?.timestamp || 0);
  const lastTs = Number(items[items.length - 1]?.timestamp || 0);
  if (firstTs > lastTs) {
    return [...items].reverse();
  }
  return items;
}

function renderMessageList(container, items) {
  container.innerHTML = '';

  if (!Array.isArray(items) || items.length === 0) {
    renderEmptyState(container, '(none)');
    return;
  }

  const orderedItems = toConversationOrder(items);
  for (const item of orderedItems) {
    const role = String(item.role || 'unknown').toLowerCase();
    const isUser = role === 'user';
    const row = document.createElement('div');
    row.className = `memory-chat-row ${isUser ? 'user' : 'model'}`;
    row.innerHTML = `
      <div class="memory-chat-bubble ${isUser ? 'user' : 'model'}">
        <div class="memory-chat-meta">${escapeHtml(role)} | ${escapeHtml(formatTimestamp(item.timestamp))}</div>
        <div class="memory-chat-content">${renderMarkdownToHtml(item.content)}</div>
      </div>
    `;
    container.appendChild(row);
  }

  scrollToBottom(container);
}

export function mountMemoryView(container, ctx) {
  const scope = createViewScope();
  container.innerHTML = `
    <section class="memory-view">
      <header class="memory-toolbar">
        <div class="row">
          <h2 class="title">Memory</h2>
          <span class="muted">檢索、瀏覽與匯出歷史對話</span>
        </div>
      </header>

      <section class="memory-panels">
        <div class="panel col">
          <div class="panel-title">搜尋記憶內容</div>
          <div class="row">
            <input id="searchInput" style="flex:1;" placeholder="關鍵字" />
            <button id="searchBtn">搜尋</button>
          </div>
          <div class="muted">可搜尋近期對話與系統回覆內容</div>
        </div>
        <div class="panel col">
          <div class="panel-title">歷史操作</div>
          <div class="row">
            <button id="refreshHistoryBtn">刷新最新</button>
            <button id="prevPageBtn">上一頁</button>
            <button id="nextPageBtn">下一頁</button>
          </div>
          <div class="row">
            <button id="exportJsonBtn">匯出 JSON</button>
            <button id="exportCsvBtn">匯出 CSV</button>
            <span id="pageInfo" class="muted" style="margin-left:auto;"></span>
          </div>
        </div>
      </section>

      <section class="memory-content">
        <div class="col">
          <div>
            <div class="muted" style="margin:0 0 6px 4px;">搜尋結果</div>
            <div id="searchList" class="list memory-chat-list" style="max-height:220px;"></div>
          </div>
          <div>
            <div class="muted" style="margin:0 0 6px 4px;">歷史對話</div>
            <div id="historyList" class="list memory-chat-list" style="min-height:360px;"></div>
          </div>
        </div>
      </section>
    </section>
  `;

  const searchInput = byId(container, '#searchInput');
  const searchList = byId(container, '#searchList');
  const historyList = byId(container, '#historyList');
  const pageInfo = byId(container, '#pageInfo');

  const searchBtn = byId(container, '#searchBtn');
  const refreshHistoryBtn = byId(container, '#refreshHistoryBtn');
  const prevPageBtn = byId(container, '#prevPageBtn');
  const nextPageBtn = byId(container, '#nextPageBtn');
  const exportJsonBtn = byId(container, '#exportJsonBtn');
  const exportCsvBtn = byId(container, '#exportCsvBtn');

  let offset = 0;
  const limit = 12;
  let stopMemoryStream = null;

  async function doSearch() {
    const q = (searchInput.value || '').trim();
    if (!q) {
      renderEmptyState(searchList, '請輸入關鍵字');
      return;
    }
    const data = await ctx.services.memory.search(q, 20);
    renderMessageList(searchList, data.items || []);
  }

  async function loadHistory() {
    const data = await ctx.services.memory.getHistory(offset, limit);
    renderMessageList(historyList, data.items || []);
    const total = Number(data.total || 0);
    const page = Math.floor(offset / limit) + 1;
    const pages = Math.max(1, Math.ceil(total / limit));
    pageInfo.textContent = `page ${page}/${pages} total ${total}`;
    prevPageBtn.disabled = offset <= 0;
    nextPageBtn.disabled = !(data.hasMore === true);
  }

  async function refreshLatest() {
    offset = 0;
    await loadHistory();
    if ((searchInput.value || '').trim()) {
      await doSearch();
    }
  }

  function exportMemory(format) {
    window.open(ctx.services.memory.exportUrl(format), '_blank');
  }

  const onSearch = () => void doSearch().catch((e) => setListError(searchList, e));
  const onRefreshHistory = () => void refreshLatest().catch((e) => setListError(historyList, e));
  const onPrev = () => {
    offset = Math.max(0, offset - limit);
    void loadHistory().catch((e) => setListError(historyList, e));
  };
  const onNext = () => {
    offset += limit;
    void loadHistory().catch((e) => setListError(historyList, e));
  };
  const onSearchEnter = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void onSearch();
    }
  };

  scope.on(searchBtn, 'click', onSearch);
  scope.on(refreshHistoryBtn, 'click', onRefreshHistory);
  scope.on(prevPageBtn, 'click', onPrev);
  scope.on(nextPageBtn, 'click', onNext);
  scope.on(exportJsonBtn, 'click', () => exportMemory('json'));
  scope.on(exportCsvBtn, 'click', () => exportMemory('csv'));
  scope.on(searchInput, 'keydown', onSearchEnter);
  scope.on(container, 'view:show', () => {
    onRefreshHistory();
  });

  stopMemoryStream = ctx.services.memory.streamUpdates({
    snapshot() {
      onRefreshHistory();
    },
    update() {
      onRefreshHistory();
    }
  });

  renderEmptyState(searchList, '請輸入關鍵字');
  void loadHistory();

  return () => {
    if (typeof stopMemoryStream === 'function') {
      stopMemoryStream();
      stopMemoryStream = null;
    }
    scope.destroy();
  };
}
