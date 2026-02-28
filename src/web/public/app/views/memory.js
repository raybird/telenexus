import { byId } from '../utils/dom.js';
import { escapeHtml, formatTimestamp } from '../utils/format.js';
import { setListError } from '../utils/list.js';
import { createViewScope } from '../utils/view.js';

function renderEmptyState(container, text) {
  container.innerHTML = `<div class="item">${escapeHtml(text)}</div>`;
}

function inlineMarkdownToHtml(text) {
  const inlineCodes = [];
  const withTokens = String(text || '').replace(/`([^`\n]+)`/g, (_full, code) => {
    const token = `@@INLINE_${inlineCodes.length}@@`;
    inlineCodes.push(`<code>${escapeHtml(String(code || ''))}</code>`);
    return token;
  });

  let html = escapeHtml(withTokens);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_full, label, url) => {
    const safeUrl = escapeHtml(String(url || ''));
    const safeLabel = escapeHtml(String(label || ''));
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/@@INLINE_(\d+)@@/g, (_full, index) => inlineCodes[Number(index)] || '');
  return html;
}

function parseTable(lines, start) {
  if (start + 1 >= lines.length) {
    return null;
  }
  const header = lines[start] || '';
  const divider = lines[start + 1] || '';
  if (!header.includes('|') || !divider.includes('|')) {
    return null;
  }
  const dividerCompact = divider.replace(/\|/g, '').replace(/:/g, '').replace(/-/g, '').trim();
  if (dividerCompact.length > 0 || !/-{3,}/.test(divider)) {
    return null;
  }

  const splitCells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const headers = splitCells(header);
  const rows = [];
  let cursor = start + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] || '';
    if (!line.includes('|') || line.trim().length === 0) {
      break;
    }
    rows.push(splitCells(line));
    cursor += 1;
  }
  return { headers, rows, end: cursor };
}

function markdownToHtml(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const fenced = [];
  const source = normalized.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_full, code) => {
    const token = `@@FENCED_${fenced.length}@@`;
    fenced.push(`<pre><code>${escapeHtml(String(code || ''))}</code></pre>`);
    return token;
  });

  const lines = source.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('@@FENCED_')) {
      blocks.push(trimmed);
      i += 1;
      continue;
    }

    const table = parseTable(lines, i);
    if (table) {
      const headerHtml = table.headers
        .map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`)
        .join('');
      const bodyHtml = table.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${inlineMarkdownToHtml(cell)}</td>`).join('')}</tr>`
        )
        .join('');
      blocks.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`
      );
      i = table.end;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, '');
      blocks.push(`<h4>${inlineMarkdownToHtml(heading)}</h4>`);
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(trimmed)) {
      const items = [];
      let cursor = i;
      while (cursor < lines.length && /^\s*[-*]\s+/.test(lines[cursor] || '')) {
        items.push((lines[cursor] || '').replace(/^\s*[-*]\s+/, ''));
        cursor += 1;
      }
      blocks.push(
        `<ul>${items.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('')}</ul>`
      );
      i = cursor;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(trimmed)) {
      const items = [];
      let cursor = i;
      while (cursor < lines.length && /^\s*\d+\.\s+/.test(lines[cursor] || '')) {
        items.push((lines[cursor] || '').replace(/^\s*\d+\.\s+/, ''));
        cursor += 1;
      }
      blocks.push(
        `<ol>${items.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('')}</ol>`
      );
      i = cursor;
      continue;
    }

    const paragraphLines = [line];
    let cursor = i + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor] || '';
      if (!candidate.trim()) {
        break;
      }
      if (candidate.trim().startsWith('@@FENCED_')) {
        break;
      }
      if (/^#{1,6}\s+/.test(candidate.trim())) {
        break;
      }
      if (/^\s*[-*]\s+/.test(candidate) || /^\s*\d+\.\s+/.test(candidate)) {
        break;
      }
      if (parseTable(lines, cursor)) {
        break;
      }
      paragraphLines.push(candidate);
      cursor += 1;
    }
    blocks.push(
      `<p>${paragraphLines.map((item) => inlineMarkdownToHtml(item)).join('<br />')}</p>`
    );
    i = cursor;
  }

  return blocks
    .join('')
    .replace(/@@FENCED_(\d+)@@/g, (_full, index) => fenced[Number(index)] || '');
}

function formatMessageContent(text) {
  return markdownToHtml(text);
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
        <div class="memory-chat-content">${formatMessageContent(item.content)}</div>
      </div>
    `;
    container.appendChild(row);
  }

  scrollToBottom(container);
}

export function mountMemoryView(container, ctx) {
  const scope = createViewScope();
  container.innerHTML = `
    <h2 class="title">Memory</h2>
    <section class="col">
      <div class="row">
        <strong>Search</strong>
        <input id="searchInput" style="flex:1;" placeholder="關鍵字" />
        <button id="searchBtn">搜尋</button>
      </div>
      <div id="searchList" class="list memory-chat-list"></div>
    </section>

    <section class="col" style="margin-top:12px;">
      <div class="row">
        <strong>History</strong>
        <button id="refreshHistoryBtn">刷新最新</button>
        <button id="prevPageBtn">上一頁</button>
        <button id="nextPageBtn">下一頁</button>
        <span id="pageInfo" class="muted"></span>
        <span style="flex:1;"></span>
        <button id="exportJsonBtn">匯出 JSON</button>
        <button id="exportCsvBtn">匯出 CSV</button>
      </div>
      <div id="historyList" class="list memory-chat-list"></div>
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
