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
          <span style="flex:1;"></span>
          <button id="reloadRecentBtn">重載近期訊息</button>
        </div>
      </header>

      <div class="chat-stream">
        <div id="chatMessages" class="list memory-chat-list" style="min-height:100%;"></div>
      </div>

      <footer class="chat-composer">
        <div class="chat-input-row">
          <input id="chatInput" placeholder="輸入訊息，按 Enter 送出" autocomplete="off" />
          <button id="chatSendBtn">送出</button>
        </div>
        <div class="row">
          <input id="tokenInput" style="flex:1;" placeholder="API token（可留白）" autocomplete="off" />
          <button id="saveTokenBtn">儲存 Token</button>
          <span class="muted" id="chatStatus">Ready</span>
        </div>
      </footer>
    </section>
  `;

  const scope = createViewScope();
  const messages = byId(container, '#chatMessages');
  const input = byId(container, '#chatInput');
  const sendBtn = byId(container, '#chatSendBtn');
  const reloadRecentBtn = byId(container, '#reloadRecentBtn');
  const tokenInput = byId(container, '#tokenInput');
  const saveTokenBtn = byId(container, '#saveTokenBtn');
  const status = byId(container, '#chatStatus');

  tokenInput.value = ctx.state.getToken();

  function clearMessages() {
    messages.innerHTML = '';
  }

  function addMessageBubble(role, content, metaText) {
    const isUser = role === 'user';
    const row = document.createElement('div');
    row.className = `memory-chat-row ${isUser ? 'user' : 'model'}`;
    row.innerHTML = `
      <div class="memory-chat-bubble ${isUser ? 'user' : 'model'}">
        <div class="memory-chat-meta">${escapeHtml(metaText)}</div>
        <div class="memory-chat-content">${renderMarkdownToHtml(content)}</div>
      </div>
    `;
    messages.appendChild(row);
    scrollToBottom(messages);
    const contentNode = row.querySelector('.memory-chat-content');
    return contentNode instanceof HTMLElement ? contentNode : null;
  }

  async function loadRecentMessages() {
    status.textContent = 'Loading recent...';
    const data = await ctx.services.memory.getRecent(36);
    const orderedItems = toConversationOrder(Array.isArray(data.items) ? data.items : []);
    clearMessages();

    if (orderedItems.length === 0) {
      status.textContent = 'Ready';
      return;
    }

    for (const item of orderedItems) {
      const role = item.role === 'user' ? 'user' : 'model';
      addMessageBubble(role, item.content || '', `${role} | ${formatTimestamp(item.timestamp)}`);
    }

    status.textContent = 'Ready';
  }

  async function sendMessage() {
    const text = (input.value || '').trim();
    if (!text) return;

    input.value = '';
    addMessageBubble('user', text, `user | ${formatTimestamp(Date.now())}`);
    status.textContent = 'Thinking...';

    let modelContentNode = null;
    let modelBuffer = '';
    const ensureModelNode = () => {
      if (modelContentNode) return modelContentNode;
      modelContentNode = addMessageBubble('model', '', 'model | streaming');
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
          scrollToBottom(messages);
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
          status.textContent = 'Done';
          scrollToBottom(messages);
        },
        error(payload) {
          status.textContent = payload.error || 'Stream error';
        }
      });
    } catch (error) {
      addMessageBubble(
        'model',
        `錯誤：${toErrorMessage(error)}`,
        `model | ${formatTimestamp(Date.now())}`
      );
      status.textContent = 'Error';
    }
  }

  scope.on(sendBtn, 'click', () => scope.run(sendMessage));
  scope.on(input, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      scope.run(sendMessage);
    }
  });
  scope.on(reloadRecentBtn, 'click', () =>
    scope.run(async () => {
      try {
        await loadRecentMessages();
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
  scope.on(container, 'view:show', () => {
    scope.run(async () => {
      try {
        await loadRecentMessages();
      } catch (error) {
        status.textContent = `Error: ${toErrorMessage(error)}`;
      }
    });
  });

  void scope.run(loadRecentMessages);

  return () => scope.destroy();
}
