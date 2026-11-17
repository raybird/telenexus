// issue 0030：模型面板前端。API 一律同源相對路徑，換網址不必改；憑證只放記憶體。
// 所有來自伺服器的字串（模型 ID、錯誤訊息）一律用 textContent 寫入，不把字串當成 HTML 解析。

const SOURCE_LABELS = {
  override: '/set_model 或本面板設定（data/ai-config.override.yaml）',
  base: '預設（ai-config.yaml）',
  none: '未設定（使用 opencode 預設）'
};

const ERROR_MESSAGES = {
  'not-listed': '這個模型不在目前的清單裡，請重新整理清單後再選。',
  'invalid-model': '模型 ID 格式不正確。',
  'list-failed': '取不到模型清單，所以沒有套用。',
  'write-failed': '寫入設定失敗，原本的設定沒有變。'
};

const $ = (id) => document.getElementById(id);
const tg = window.Telegram?.WebApp;

let token = '';
let models = [];
let state = null;

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
}

async function api(method, path, body) {
  const res = await fetch(`../panel-api/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // 下面依狀態碼處理
  }
  if (res.status === 401) {
    throw new Error('登入已失效（入口可能已關閉或換了網址）。請關閉面板，在 Telegram 輸入 /panel 後從選單按鈕重新開啟。');
  }
  if (!res.ok || data.ok === false) {
    const message = ERROR_MESSAGES[data.error] ?? `操作失敗（HTTP ${res.status}）`;
    throw new Error(data.message ? `${message}（${data.message}）` : message);
  }
  return data;
}

function renderState() {
  $('current-model').textContent = state?.model ?? '未設定';
  $('current-source').textContent = SOURCE_LABELS[state?.source] ?? '—';
  $('reset').disabled = state?.source !== 'override';
}

function renderProviders(providers) {
  const select = $('provider');
  const current = select.value;
  select.replaceChildren(new Option('全部', ''));
  for (const p of providers) select.add(new Option(p, p));
  select.value = providers.includes(current) ? current : '';
}

function renderModels() {
  const provider = $('provider').value;
  const query = $('query').value.trim().toLowerCase();
  const checked = new FormData($('model-form')).get('model') ?? state?.model;
  const shown = models.filter(
    (m) => (!provider || m.provider === provider) && (!query || m.id.toLowerCase().includes(query))
  );

  const list = $('models');
  list.replaceChildren(
    ...shown.map((m) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'model';
      input.value = m.id;
      input.checked = m.id === checked;
      const code = document.createElement('code');
      code.textContent = m.id;
      label.append(input, code);
      if (m.id === state?.model) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '目前使用';
        label.append(tag);
      }
      return label;
    })
  );

  $('count').textContent = `${shown.length} / ${models.length}`;
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  empty.textContent =
    models.length === 0 ? 'opencode 沒有列出任何模型。' : '沒有符合篩選條件的模型。';
}

async function loadModels() {
  setStatus('載入模型清單中…');
  try {
    const data = await api('GET', 'models');
    models = data.models;
    renderProviders(data.providers);
    renderModels();
    setStatus(models.length === 0 ? 'opencode 沒有列出任何模型。' : '清單已更新。');
  } catch (error) {
    models = [];
    renderModels();
    $('empty').textContent = '模型清單取得失敗。';
    setStatus(error.message, 'error');
  }
}

async function loadState() {
  const data = await api('GET', 'state');
  state = data.model;
  renderState();
}

async function withBusy(fn) {
  const buttons = ['apply', 'reset', 'refresh'].map($);
  const before = buttons.map((b) => b.disabled);
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } finally {
    buttons.forEach((b, i) => (b.disabled = before[i]));
    renderState();
  }
}

async function onApply(event) {
  event.preventDefault();
  const id = new FormData($('model-form')).get('model');
  if (!id) {
    setStatus('請先選一個模型。', 'error');
    $('models').querySelector('input')?.focus();
    return;
  }
  if (id === state?.model) {
    setStatus('這個模型已經是目前的設定。');
    return;
  }
  await withBusy(async () => {
    try {
      const data = await api('POST', 'apply', { model: id });
      state = data.model;
      renderModels();
      setStatus(`已套用 ${id}。下一則新訊息與之後的排程生效。`);
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });
}

async function onReset() {
  await withBusy(async () => {
    try {
      const data = await api('POST', 'reset');
      state = data.model;
      renderModels();
      setStatus(
        data.changed
          ? `已恢復預設：${state?.model ?? '未設定（使用 opencode 預設）'}。`
          : '目前已經是預設設定。'
      );
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });
}

async function start() {
  tg?.ready();
  tg?.expand();
  const initData = tg?.initData ?? '';
  if (!initData) {
    setStatus('請從 Telegram 私聊的「模型設定」選單按鈕開啟這個面板。', 'error');
    $('current-model').textContent = '—';
    return;
  }
  try {
    const login = await api('POST', 'login', { initData });
    token = login.token;
    await loadState();
  } catch (error) {
    setStatus(error.message, 'error');
    $('current-model').textContent = '—';
    return;
  }
  $('model-form').addEventListener('submit', onApply);
  $('reset').addEventListener('click', onReset);
  $('refresh').addEventListener('click', () => withBusy(loadModels));
  $('provider').addEventListener('change', renderModels);
  $('query').addEventListener('input', renderModels);
  await loadModels();
}

void start();
