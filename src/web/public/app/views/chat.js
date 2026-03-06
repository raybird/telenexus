import { byId } from '../utils/dom.js';
import { escapeHtml, formatTimestamp, toErrorMessage } from '../utils/format.js';
import { renderMarkdownToHtml } from '../utils/markdown.js';
import { createViewScope } from '../utils/view.js';

function scrollToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

const TOP_LOAD_THRESHOLD_PX = 80;
const HISTORY_PAGE_SIZE = 40;

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

export function mountChatView(container, ctx) {
  container.innerHTML = `
    <section class="chat-view">
      <header class="chat-toolbar">
        <div class="row">
          <h2 class="title">Chat</h2>
          <span class="muted">即時串流對話</span>
          <span class="flex-1"></span>
          <button id="reloadRecentBtn">重載近期訊息</button>
        </div>
      </header>

      <div class="chat-stream">
        <div id="chatMessages" class="memory-chat-list chat-messages"></div>
      </div>

      <div class="chat-composer-wrap">
        <div class="chat-composer">
          <div class="chat-input-row">
            <textarea id="chatInput" rows="1" placeholder="輸入訊息，按 Enter 送出 (Shift+Enter 換行)" autocomplete="off"></textarea>
            <button id="chatSendBtn" class="chat-send-btn" aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            </button>
          </div>
        </div>
        <div class="chat-tools">
          <div class="row">
            <input id="tokenInput" placeholder="API token (可留白)" autocomplete="off" />
            <button id="saveTokenBtn" class="btn-sm">儲存 Token</button>
          </div>
          <div id="chatStatus">Ready</div>
        </div>
      </div>
    </section>
  `;

  const scope = createViewScope();
  const stream = byId(container, '.chat-stream');
  const messages = byId(container, '#chatMessages');
  const input = byId(container, '#chatInput');
  const sendBtn = byId(container, '#chatSendBtn');
  const reloadRecentBtn = byId(container, '#reloadRecentBtn');
  const tokenInput = byId(container, '#tokenInput');
  const saveTokenBtn = byId(container, '#saveTokenBtn');
  const status = byId(container, '#chatStatus');

  tokenInput.value = ctx.state.getToken();

  const chatState = {
    items: [],
    hasMore: true,
    loading: false,
    isStreaming: false,
    oldestLoadedTimestamp: null
  };

  let topLoadingIndicator = null;
  let scrollTicking = false;
  let fillViewportPromise = null;

  function getDateLabel(timestamp) {
    const stamp = new Date(timestamp);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;

    if (timestamp >= todayStart) return '今天';
    if (timestamp >= yesterdayStart) return '昨天';
    return stamp.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
  }

  function createDateDividerElement(dateLabel) {
    const divider = document.createElement('div');
    divider.className = 'chat-date-divider';
    const span = document.createElement('span');
    span.textContent = dateLabel;
    divider.appendChild(span);
    return divider;
  }

  function createMessageRowElement(item) {
    const role = item.role === 'user' ? 'user' : 'model';
    const isUser = role === 'user';
    const ts = Number(item.timestamp || Date.now());
    const row = document.createElement('div');
    row.className = `memory-chat-row ${isUser ? 'user' : 'model'}`;
    row.dataset.timestamp = String(ts);
    row.dataset.role = role;

    const timeStr = new Date(ts).toLocaleTimeString('zh-TW', {
      hour: '2-digit',
      minute: '2-digit'
    });

    row.innerHTML = `
      <div class="memory-chat-bubble ${isUser ? 'user' : 'model'}">
        <div class="memory-chat-meta">${isUser ? 'You' : 'TeleNexus'} <span style="opacity:0.6;font-size:11px;margin-left:6px">${timeStr}</span></div>
        <div class="memory-chat-content">${renderMarkdownToHtml(item.content || '')}</div>
      </div>
    `;

    return row;
  }

  function setTopLoadingIndicator(visible) {
    if (visible) {
      if (!topLoadingIndicator) {
        const loader = document.createElement('div');
        loader.className = 'thread-loading chat-top-loading';
        loader.textContent = '載入歷史紀錄中';
        topLoadingIndicator = loader;
      }
      if (!topLoadingIndicator.isConnected) {
        stream.prepend(topLoadingIndicator);
      }
    } else {
      topLoadingIndicator?.remove();
    }
  }

  function getViewportAnchor() {
    const streamTop = stream.getBoundingClientRect().top;
    const candidates = messages.querySelectorAll('.chat-date-divider, .memory-chat-row');
    for (const node of candidates) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom >= streamTop + 4) {
        return node;
      }
    }
    return messages.querySelector('.chat-date-divider, .memory-chat-row');
  }

  function ensureTopLoaderSpacing() {
    if (!topLoadingIndicator?.isConnected) return;
    const loaderHeight = topLoadingIndicator.getBoundingClientRect().height;
    messages.style.scrollMarginTop = `${Math.ceil(loaderHeight + 12)}px`;
  }

  function clearTopLoaderSpacing() {
    messages.style.scrollMarginTop = '';
  }

  async function fillViewportIfNeeded() {
    if (fillViewportPromise) {
      await fillViewportPromise;
      return;
    }

    fillViewportPromise = (async () => {
      while (
        !chatState.loading &&
        !chatState.isStreaming &&
        chatState.hasMore &&
        stream.scrollHeight <= stream.clientHeight + TOP_LOAD_THRESHOLD_PX
      ) {
        await loadOlderMessages(false);
      }
    })();

    try {
      await fillViewportPromise;
    } finally {
      fillViewportPromise = null;
    }
  }

  function prependOlderMessages(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return;
    }

    const firstExistingRow = messages.querySelector('.memory-chat-row');
    let firstExistingDateLabel = null;
    if (firstExistingRow instanceof HTMLElement) {
      const ts = Number(firstExistingRow.dataset.timestamp || 0);
      if (Number.isFinite(ts) && ts > 0) {
        firstExistingDateLabel = getDateLabel(ts);
      }
    }

    const fragment = document.createDocumentFragment();
    let previousDateLabel = null;
    for (const item of items) {
      const ts = Number(item.timestamp || 0);
      const dateLabel = getDateLabel(ts);
      if (dateLabel !== previousDateLabel) {
        fragment.appendChild(createDateDividerElement(dateLabel));
        previousDateLabel = dateLabel;
      }
      fragment.appendChild(createMessageRowElement(item));
    }

    if (firstExistingDateLabel && previousDateLabel === firstExistingDateLabel) {
      const firstDivider = messages.querySelector('.chat-date-divider');
      if (firstDivider && firstDivider.nextElementSibling === firstExistingRow) {
        firstDivider.remove();
      }
    }

    messages.prepend(fragment);
  }

  function renderAllMessages() {
    const oldScrollHeight = stream.scrollHeight;
    const oldScrollTop = stream.scrollTop;

    const isAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 10;
    const isFirstLoad = chatState.items.length > 0 && oldScrollHeight === 0;

    messages.innerHTML = '';
    let lastDateLabel = null;

    for (const item of chatState.items) {
      const dateLabel = getDateLabel(item.timestamp);
      if (dateLabel !== lastDateLabel) {
        messages.appendChild(createDateDividerElement(dateLabel));
        lastDateLabel = dateLabel;
      }
      messages.appendChild(createMessageRowElement(item));
    }

    if (isFirstLoad || (isAtBottom && oldScrollHeight > 0)) {
      scrollToBottom(stream);
    } else if (oldScrollTop <= 80 && oldScrollHeight > 0) {
      const heightDelta = stream.scrollHeight - oldScrollHeight;
      stream.scrollTop = Math.max(0, oldScrollTop + heightDelta);
    }
  }

  async function loadOlderMessages(isInitial = false) {
    if (chatState.loading || !chatState.hasMore || chatState.isStreaming) return;

    chatState.loading = true;

    let anchorElement = null;
    let anchorTopBefore = 0;
    let oldScrollHeight = 0;
    let oldScrollTop = 0;
    if (!isInitial) {
      oldScrollHeight = stream.scrollHeight;
      oldScrollTop = stream.scrollTop;
      anchorElement = getViewportAnchor();
      anchorTopBefore = anchorElement ? anchorElement.getBoundingClientRect().top : 0;
      setTopLoadingIndicator(true);
      ensureTopLoaderSpacing();
    }

    try {
      if (isInitial) status.textContent = 'Loading history...';
      const data =
        typeof chatState.oldestLoadedTimestamp === 'number' && chatState.oldestLoadedTimestamp > 0
          ? await ctx.services.memory.getHistoryBefore(
              chatState.oldestLoadedTimestamp,
              HISTORY_PAGE_SIZE
            )
          : await ctx.services.memory.getHistoryBefore(null, HISTORY_PAGE_SIZE);
      const rawItems = Array.isArray(data.items) ? data.items : [];

      const orderedNew = toConversationOrder(rawItems);
      if (isInitial) {
        chatState.items = orderedNew;
      } else {
        chatState.items = orderedNew.concat(chatState.items);
      }

      if (typeof data.hasMore === 'boolean') {
        chatState.hasMore = data.hasMore;
      } else {
        chatState.hasMore = rawItems.length >= HISTORY_PAGE_SIZE;
      }

      const nextBefore = Number(data.nextBeforeTimestamp || 0);
      if (Number.isFinite(nextBefore) && nextBefore > 0) {
        chatState.oldestLoadedTimestamp = nextBefore;
      } else if (chatState.items.length > 0) {
        chatState.oldestLoadedTimestamp = Math.min(
          ...chatState.items
            .map((item) => Number(item.timestamp || 0))
            .filter((ts) => Number.isFinite(ts))
        );
      }

      if (!isInitial) {
        prependOlderMessages(orderedNew);

        if (anchorElement && anchorElement.isConnected) {
          const anchorTopAfter = anchorElement.getBoundingClientRect().top;
          stream.scrollTop += anchorTopAfter - anchorTopBefore;
        } else {
          const heightDelta = stream.scrollHeight - oldScrollHeight;
          stream.scrollTop = Math.max(0, oldScrollTop + heightDelta);
        }
      }
    } catch (e) {
      status.textContent = 'Error loading history';
      console.error(e);
    } finally {
      chatState.loading = false;
      if (!isInitial) {
        setTopLoadingIndicator(false);
        clearTopLoaderSpacing();
      }
      if (isInitial) {
        renderAllMessages();
      }
      if (isInitial) {
        status.textContent = 'Ready';
        scrollToBottom(stream);
        void fillViewportIfNeeded();
      }
    }
  }

  function addMessageBubble(role, content, timestamp) {
    const dateLabel = getDateLabel(timestamp);
    const dividers = messages.querySelectorAll('.chat-date-divider span');
    const lastDivider = dividers.length > 0 ? dividers[dividers.length - 1].textContent : null;

    if (dateLabel !== lastDivider) {
      messages.insertAdjacentHTML(
        'beforeend',
        `<div class="chat-date-divider"><span>${dateLabel}</span></div>`
      );
    }

    const row = createMessageRowElement({ role, content, timestamp });
    messages.appendChild(row);
    scrollToBottom(stream);
    const contentNode = row.querySelector('.memory-chat-content');
    return contentNode instanceof HTMLElement ? contentNode : null;
  }

  async function sendMessage() {
    const text = (input.value || '').trim();
    if (!text) return;

    input.value = '';
    const userTs = Date.now();
    addMessageBubble('user', text, userTs);
    chatState.items.push({ role: 'user', content: text, timestamp: userTs });

    status.textContent = 'Thinking...';
    chatState.isStreaming = true;

    let modelContentNode = null;
    let modelBuffer = '';
    const modelTs = Date.now();

    const ensureModelNode = () => {
      if (modelContentNode) return modelContentNode;
      modelContentNode = addMessageBubble('model', '', modelTs);
      return modelContentNode;
    };

    try {
      await ctx.services.chat.streamMessage(text, {
        status(payload) {
          status.textContent = payload.text || 'Processing...';
        },
        chunk(payload) {
          const contentNode = ensureModelNode();
          const chunk = payload.text || '';
          modelBuffer = modelBuffer ? `${modelBuffer}\n\n${chunk}` : chunk;
          if (contentNode) {
            contentNode.innerHTML = renderMarkdownToHtml(modelBuffer);
          }
          status.textContent = 'Streaming...';
          scrollToBottom(stream);
        },
        done(payload) {
          if (!modelContentNode) {
            const reply = payload.reply || '(empty)';
            const contentNode = ensureModelNode();
            modelBuffer = reply;
            if (contentNode) {
              contentNode.innerHTML = renderMarkdownToHtml(reply);
            }
          }
          chatState.items.push({ role: 'model', content: modelBuffer, timestamp: modelTs });
          status.textContent = 'Done';
          scrollToBottom(stream);
        },
        error(payload) {
          status.textContent = payload.error || 'Stream error';
        }
      });
    } catch (error) {
      addMessageBubble('model', `錯誤：${toErrorMessage(error)}`, modelTs);
      chatState.items.push({
        role: 'model',
        content: `錯誤：${toErrorMessage(error)}`,
        timestamp: modelTs
      });
      status.textContent = 'Error';
    } finally {
      chatState.isStreaming = false;
    }
  }

  scope.on(sendBtn, 'click', () => {
    input.style.height = 'auto';
    scope.run(sendMessage);
  });
  scope.on(input, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      input.style.height = 'auto';
      scope.run(sendMessage);
    }
  });
  scope.on(input, 'input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });
  scope.on(reloadRecentBtn, 'click', () =>
    scope.run(async () => {
      try {
        chatState.items = [];
        chatState.hasMore = true;
        chatState.oldestLoadedTimestamp = null;
        await loadOlderMessages(true);
      } catch (error) {
        status.textContent = `Error: ${toErrorMessage(error)}`;
      }
    })
  );
  scope.on(saveTokenBtn, 'click', () => {
    ctx.state.setToken(tokenInput.value || '');
    status.textContent = 'Token saved';
  });

  scope.on(window, 'date:selected', (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail.dateLabel !== 'string') return;

    scope.run(async () => {
      const targetLabel = detail.dateLabel;
      status.textContent = `尋找日期: ${targetLabel}...`;

      let attempts = 0;
      const maxAttempts = 15;

      while (attempts < maxAttempts) {
        // Try to find the divider in the DOM
        const dividers = Array.from(messages.querySelectorAll('.chat-date-divider span'));
        const targetNode = dividers.find((span) => span.textContent === targetLabel);

        if (targetNode) {
          const dividerDiv = targetNode.parentElement;
          if (dividerDiv) {
            dividerDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            dividerDiv.classList.remove('jump-highlight');
            // Trigger reflow to restart animation
            void dividerDiv.offsetWidth;
            dividerDiv.classList.add('jump-highlight');
            status.textContent = 'Ready';
          }
          return;
        }

        // If not found, load more history
        if (!chatState.hasMore) {
          status.textContent = `已到達最早紀錄，未找到 ${targetLabel}`;
          return;
        }

        await loadOlderMessages(false);
        attempts++;
      }

      status.textContent = '搜尋逾時';
    });
  });

  scope.on(stream, 'scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      if (stream.scrollTop <= TOP_LOAD_THRESHOLD_PX) {
        void loadOlderMessages(false).then(() => fillViewportIfNeeded());
      }
    });
  });

  scope.on(container, 'view:show', () => {
    scope.run(async () => {
      try {
        if (chatState.items.length === 0) {
          await loadOlderMessages(true);
        } else {
          scrollToBottom(stream);
        }
      } catch (error) {
        status.textContent = `Error: ${toErrorMessage(error)}`;
      }
    });
  });

  void scope.run(async () => {
    await loadOlderMessages(true);
  });

  return () => scope.destroy();
}
