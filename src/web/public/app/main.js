import { createState } from './state.js';
import { createApi } from './api.js';
import { ensureHashRoute, normalizeRouteFromHash } from './router.js';
import { parsePercent } from './utils/format.js';
import { byId } from './utils/dom.js';
import { createChatService } from './services/chat-service.js';
import { createMemoryService } from './services/memory-service.js';
import { createScheduleService } from './services/schedule-service.js';
import { createStatusService } from './services/status-service.js';
import { mountChatView } from './views/chat.js';
import { mountMemoryView } from './views/memory.js';
import { mountSchedulesView } from './views/schedules.js';
import { mountStatusView } from './views/status.js';

const appRoot = byId(document, '#app');
const menu = byId(document, '#menu');
const globalStatus = byId(document, '#globalStatus');
const globalAlert = byId(document, '#globalAlert');
const recentThreads = byId(document, '#recentThreads');
const refreshThreadsBtn = byId(document, '#refreshThreadsBtn');
const themeToggle = byId(document, '#themeToggle');

const config = window.__APP_CONFIG__ || {};
const state = createState(config);
const api = createApi(state);
const services = {
  chat: createChatService(api),
  memory: createMemoryService(api, state),
  schedules: createScheduleService(api),
  status: createStatusService(api)
};

const viewCache = new Map();
let activeRoute = null;
let healthTimer = null;
let selectedThreadId = '';

const routes = {
  chat: mountChatView,
  memory: mountMemoryView,
  schedules: mountSchedulesView,
  status: mountStatusView
};

function updateMenuActive(route) {
  const links = menu.querySelectorAll('a[data-route]');
  links.forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return;
    const isActive = link.dataset.route === route;
    if (isActive) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}

function hideAlert() {
  globalAlert.className = 'alert';
  globalAlert.textContent = '';
}

function showAlert(level, text) {
  globalAlert.className = `alert show ${level}`;
  globalAlert.textContent = text;
}

function trimPreview(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '(empty)';
  return normalized.length > 46 ? `${normalized.slice(0, 46)}...` : normalized;
}

function buildRecentThreads(items) {
  const userMessages = (Array.isArray(items) ? items : []).filter(
    (item) =>
      String(item.role || '').toLowerCase() === 'user' &&
      String(item.content || '').trim().length > 0
  );

  return userMessages.slice(0, 12).map((item, index) => ({
    id: `${Number(item.timestamp || 0)}-${index}`,
    timestamp: Number(item.timestamp || 0),
    preview: trimPreview(item.content || '')
  }));
}

function renderRecentThreads(items) {
  recentThreads.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    recentThreads.innerHTML = '<div class="thread-empty">暫無可顯示的近期對話</div>';
    return;
  }

  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thread-item${selectedThreadId === item.id ? ' active' : ''}`;
    const stamp = new Date(item.timestamp).toLocaleString('zh-TW');
    button.innerHTML = `
      <div class="thread-title">${item.preview}</div>
      <div class="thread-meta">${stamp}</div>
    `;
    button.addEventListener('click', () => {
      selectedThreadId = item.id;
      renderRecentThreads(items);
      window.location.hash = '#/chat';
      window.dispatchEvent(
        new CustomEvent('thread:selected', {
          detail: { id: item.id, preview: item.preview, timestamp: item.timestamp }
        })
      );
    });
    recentThreads.appendChild(button);
  }
}

async function refreshRecentThreads() {
  try {
    const data = await services.memory.getRecent(120);
    renderRecentThreads(buildRecentThreads(data.items || []));
  } catch {
    recentThreads.innerHTML = '<div class="thread-empty">讀取近期對話失敗</div>';
  }
}

async function refreshGlobalHealth() {
  try {
    await services.status.getHealth();
    state.setHealth(true);
    globalStatus.textContent = 'online';
    globalStatus.classList.remove('offline');
    globalStatus.classList.add('online');
  } catch {
    state.setHealth(false);
    globalStatus.textContent = 'offline';
    globalStatus.classList.remove('online');
    globalStatus.classList.add('offline');
  }
}

async function refreshGlobalAlert() {
  try {
    const data = await services.status.getStatus();
    const st = data.structured || {};
    const issues = Array.isArray(st.error?.recentIssues) ? st.error.recentIssues.length : 0;
    const runnerSuccess = parsePercent(st.runner?.success_rate || '');
    const errorThreshold = Number(state.get().config.errorThreshold || 1);
    const runnerWarnThreshold = Number(state.get().config.runnerWarnThreshold || 80);

    if (issues >= errorThreshold) {
      showAlert('danger', `Runtime Alert: 最近錯誤 ${issues} 筆`);
      return;
    }
    if (runnerSuccess !== null && runnerSuccess < runnerWarnThreshold) {
      showAlert('warn', `Runner Warning: success rate ${runnerSuccess}% < ${runnerWarnThreshold}%`);
      return;
    }
    hideAlert();
  } catch {
    showAlert('danger', 'Dashboard Error: 無法讀取狀態資料');
  }
}

function renderRoute() {
  appRoot.classList.add('route-switching');
  const route = normalizeRouteFromHash(window.location.hash);
  state.setRoute(route);
  updateMenuActive(route);
  appRoot.classList.toggle('chat-active', route === 'chat');

  if (!viewCache.has(route)) {
    const viewContainer = document.createElement('section');
    viewContainer.dataset.route = route;
    viewContainer.style.display = 'none';
    appRoot.appendChild(viewContainer);

    const mount = routes[route] || routes.chat;
    const destroy = mount(viewContainer, { state, services });
    viewCache.set(route, {
      container: viewContainer,
      destroy: typeof destroy === 'function' ? destroy : null
    });
  }

  if (activeRoute && viewCache.has(activeRoute)) {
    viewCache.get(activeRoute).container.style.display = 'none';
  }

  const nextView = viewCache.get(route);
  nextView.container.style.display = 'block';
  nextView.container.dispatchEvent(
    new CustomEvent('view:show', {
      detail: { route }
    })
  );
  activeRoute = route;

  requestAnimationFrame(() => {
    appRoot.classList.remove('route-switching');
  });
}

function disposeApp() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }

  for (const view of viewCache.values()) {
    if (typeof view.destroy === 'function') {
      view.destroy();
    }
  }
  viewCache.clear();

  window.removeEventListener('hashchange', renderRoute);
  window.removeEventListener('beforeunload', disposeApp);
}

function bootstrap() {
  // Initialize theme from saved preference or system setting
  state.setTheme(state.getTheme());

  ensureHashRoute();
  renderRoute();
  window.addEventListener('hashchange', renderRoute);
  window.addEventListener('beforeunload', disposeApp);
  void refreshGlobalHealth();
  void refreshGlobalAlert();
  void refreshRecentThreads();
  healthTimer = window.setInterval(() => {
    void refreshGlobalHealth();
    void refreshGlobalAlert();
    void refreshRecentThreads();
  }, 15000);

  refreshThreadsBtn.addEventListener('click', () => {
    void refreshRecentThreads();
  });

  themeToggle.addEventListener('click', () => {
    state.toggleTheme();
  });

  // Listen for system color scheme changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      // Only auto-switch if user hasn't manually set a preference
      const saved = window.localStorage.getItem('telenexus_theme');
      if (!saved) {
        state.setTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

bootstrap();
