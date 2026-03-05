import { byId } from '../utils/dom.js';
import { escapeHtml, formatTimestamp, toErrorMessage } from '../utils/format.js';
import { renderMarkdownToHtml } from '../utils/markdown.js';
import { createViewScope } from '../utils/view.js';

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
    offset: 0,
    items: [],
    hasMore: true,
    loading: false,
    isStreaming: false
  };

  function getDateLabel(timestamp) {
    const stamp = new Date(timestamp);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;

    if (timestamp >= todayStart) return '今天';
    if (timestamp >= yesterdayStart) return '昨天';
    return stamp.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
  }

  function renderAllMessages() {
    const oldScrollHeight = stream.scrollHeight;
    const oldScrollTop = stream.scrollTop;

    const isAtBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 10;
    const isFirstLoad = chatState.offset === 40 && oldScrollHeight === 0;

    messages.innerHTML = '';
    let lastDateLabel = null;

    if (chatState.loading && chatState.offset > 0) {
      messages.insertAdjacentHTML('beforeend', `<div class="thread-loading" style="margin-bottom:16px;margin-top:0;">載入歷史紀錄中</div>`);
    }

    for (const item of chatState.items) {
      const dateLabel = getDateLabel(item.timestamp);
      if (dateLabel !== lastDateLabel) {
        messages.insertAdjacentHTML('beforeend', `<div class="chat-date-divider"><span>${dateLabel}</span></div>`);
        lastDateLabel = dateLabel;
      }

      const role = item.role === 'user' ? 'user' : 'model';
      const isUser = role === 'user';
      const timeStr = new Date(item.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

      messages.insertAdjacentHTML('beforeend', `
        <div class="memory-chat-row ${isUser ? 'user' : 'model'}">
          <div class="memory-chat-bubble ${isUser ? 'user' : 'model'}">
            <div class="memory-chat-meta">${isUser ? 'You' : 'TeleNexus'} <span style="opacity:0.6;font-size:11px;margin-left:6px">${timeStr}</span></div>
            <div class="memory-chat-content">${renderMarkdownToHtml(item.content || '')}</div>
          </div>
        </div>
      `);
    }

    if (isFirstLoad || (isAtBottom && oldScrollHeight > 0)) {
      scrollToBottom(stream);
    } else if (oldScrollTop === 0 && oldScrollHeight > 0) {
      stream.scrollTop = stream.scrollHeight - oldScrollHeight;
    }
  }

  async function loadOlderMessages(isInitial = false) {
    if (chatState.loading || !chatState.hasMore || chatState.isStreaming) return;

    chatState.loading = true;
    if (!isInitial) renderAllMessages();

    try {
      if (isInitial) status.textContent = 'Loading history...';
      const limit = 40;
      const data = await ctx.services.memory.getHistory(chatState.offset, limit);
      const rawItems = Array.isArray(data.items) ? data.items : [];

      if (rawItems.length < limit) {
        chatState.hasMore = false;
      }
      chatState.offset += limit;

      const orderedNew = toConversationOrder(rawItems);
      chatState.items = orderedNew.concat(chatState.items);
    } catch (e) {
      status.textContent = 'Error loading history';
      console.error(e);
    } finally {
      chatState.loading = false;
      renderAllMessages();
      if (isInitial) {
        status.textContent = 'Ready';
        scrollToBottom(stream);
      }
    }
  }

  function addMessageBubble(role, content, timestamp) {
    const dateLabel = getDateLabel(timestamp);
    const dividers = messages.querySelectorAll('.chat-date-divider span');
    const lastDivider = dividers.length > 0 ? dividers[dividers.length - 1].textContent : null;

    if (dateLabel !== lastDivider) {
      messages.insertAdjacentHTML('beforeend', `<div class="chat-date-divider"><span>${dateLabel}</span></div>`);
    }

    const isUser = role === 'user';
    const row = document.createElement('div');
    row.className = `memory-chat-row ${isUser ? 'user' : 'model'}`;
    const timeStr = new Date(timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

    row.innerHTML = `
      <div class="memory-chat-bubble ${isUser ? 'user' : 'model'}">
        <div class="memory-chat-meta">${isUser ? 'You' : 'TeleNexus'} <span style="opacity:0.6;font-size:11px;margin-left:6px">${timeStr}</span></div>
        <div class="memory-chat-content">${renderMarkdownToHtml(content)}</div>
      </div>
    `;
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
      chatState.items.push({ role: 'model', content: `錯誤：${toErrorMessage(error)}`, timestamp: modelTs });
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
        chatState.offset = 0;
        chatState.items = [];
        chatState.hasMore = true;
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
  scope.on(window, 'thread:selected', (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail.preview !== 'string') {
      return;
    }
    input.value = detail.preview;
    input.focus();
    status.textContent = '已載入側欄對話摘要，可直接送出或修改';
  });

  scope.on(stream, 'scroll', () => {
    if (stream.scrollTop <= 50) {
      void loadOlderMessages(false);
    }
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
