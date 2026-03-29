import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createMessagePipeline } from '../core/message-pipeline.js';
import type { AIAgent } from '../core/agent.js';
import type { CommandRouter } from '../core/command-router.js';
import type { MemoriaSyncTurn } from '../core/memoria-sync.js';
import type { MemoryManager } from '../core/memory.js';
import type { Scheduler } from '../core/scheduler.js';
import type { Connector, UnifiedMessage } from '../types/index.js';
import { safeCompare } from '../utils/crypto.js';
import { resolveContextDir } from '../utils/paths.js';
import { collectMemoryHealthReport } from '../services/memory-health.js';
import { getRecentMemoryBackfillReports } from '../services/memory-backfill.js';

type WebServerOptions = {
  enabled: boolean;
  host: string;
  port: number;
  authToken?: string;
  trustPrivateNetwork: boolean;
  alertErrorThreshold: number;
  alertRunnerSuccessWarnThreshold: number;
  defaultUserId: string;
  commandRouter: CommandRouter;
  memory: MemoryManager;
  scheduler: Scheduler;
  userAgent: AIAgent;
  chatRunnerAgent: AIAgent;
  useRunnerForChat: boolean;
  chatRunnerPercent: number;
  chatRunnerOnlyUsers: Set<string>;
  shouldSummarize: (content: string) => boolean;
  buildPrompt: (userMessage: string, userId: string) => string;
  enqueueMemoriaSync?: (turn: MemoriaSyncTurn) => void;
  recordRuntimeIssue: (scope: string, error: unknown) => void;
  writeContextSnapshots: () => void;
};

type WebServerHandle = {
  close: () => Promise<void>;
};

class CaptureConnector implements Connector {
  public name = 'WebCapture';
  private messages: Array<{ id: string; text: string }> = [];

  async initialize(): Promise<void> {
    return;
  }

  onMessage(_handler: (msg: UnifiedMessage) => void): void {
    return;
  }

  async sendMessage(_chatId: string, text: string): Promise<void> {
    this.messages.push({ id: randomUUID(), text });
  }

  async sendFile(_chatId: string, filePath: string, caption?: string): Promise<void> {
    const text = caption ? `[file] ${filePath}\n${caption}` : `[file] ${filePath}`;
    this.messages.push({ id: randomUUID(), text });
  }

  async sendPlaceholder(_chatId: string, text: string): Promise<string> {
    const id = randomUUID();
    this.messages.push({ id, text });
    return id;
  }

  async editMessage(_chatId: string, messageId: string, newText: string): Promise<void> {
    const index = this.messages.findIndex((item) => item.id === messageId);
    if (index === -1) {
      this.messages.push({ id: messageId, text: newText });
      return;
    }
    this.messages[index] = { id: messageId, text: newText };
  }

  getFinalMessage(): string {
    if (this.messages.length === 0) {
      return '';
    }
    return this.messages[this.messages.length - 1]!.text;
  }

  getAllMessages(): string[] {
    return this.messages.map((item) => item.text);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body too large (>${MAX_BODY_BYTES} bytes)`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function normalizeClientIp(rawIp?: string | null): string {
  const ip = (rawIp || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) {
    return ip.slice('::ffff:'.length);
  }
  return ip;
}

function isPrivateIpv4(ip: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = Number.parseInt(ip.split('.')[1] || '', 10);
    return Number.isFinite(second) && second >= 16 && second <= 31;
  }
  return false;
}

function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip) return false;
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  return isPrivateIpv4(ip);
}

function getClientIp(req: http.IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (forwarded) {
    const first = forwarded.split(',')[0] || '';
    return normalizeClientIp(first);
  }
  return normalizeClientIp(req.socket.remoteAddress);
}

function getHostName(req: http.IncomingMessage): string {
  const host = (req.headers.host || '').trim().toLowerCase();
  if (!host) return '';
  const hostOnly = host.includes(':') ? host.split(':')[0] || '' : host;
  return hostOnly;
}

function parseOffset(raw: string | null, fallback: number = 0): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const body = await readBody(req);
  return JSON.parse(body || '{}') as T;
}

function escapeCsv(value: string): string {
  const normalized = value.replace(/\r?\n/g, '\\n');
  if (/[",]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function writeSseEvent(
  res: http.ServerResponse,
  event: string,
  payload: Record<string, unknown>
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function splitStreamChunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized
    .split(/\n\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (blocks.length > 0) {
    return blocks;
  }

  if (!normalized.trim()) {
    return [''];
  }

  return [normalized.trim()];
}

function readAppVersion(): string {
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === 'string' && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthorized(
  req: http.IncomingMessage,
  authToken?: string,
  tokenFromQuery?: string | null,
  trustPrivateNetwork: boolean = false
): boolean {
  const clientIp = getClientIp(req);
  if (trustPrivateNetwork) {
    const hostName = getHostName(req);
    const trustedByIp = isPrivateOrLocalIp(clientIp);
    const trustedByHost = hostName === 'localhost' || isPrivateOrLocalIp(hostName);
    if (trustedByIp || trustedByHost) {
      return true;
    }
  }

  if (!authToken) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && safeCompare(header.slice(7), authToken)) {
    return true;
  }
  return typeof tokenFromQuery === 'string' && safeCompare(tokenFromQuery, authToken);
}

function readContextFile(fileName: string): string {
  try {
    const filePath = path.join(resolveContextDir(), fileName);
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function resolveWebPublicDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distCandidate = path.resolve(moduleDir, 'public');
  if (fs.existsSync(distCandidate)) {
    return distCandidate;
  }

  const srcCandidate = path.resolve(process.cwd(), 'src', 'web', 'public');
  if (fs.existsSync(srcCandidate)) {
    return srcCandidate;
  }

  return distCandidate;
}

function getStaticContentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function buildAppConfigScript(options: WebServerOptions): string {
  return JSON.stringify({
    alertErrorThreshold: options.alertErrorThreshold,
    alertRunnerSuccessWarnThreshold: options.alertRunnerSuccessWarnThreshold
  });
}

function serveStaticFile(res: http.ServerResponse, filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': getStaticContentType(filePath),
      'Content-Length': data.byteLength,
      'Cache-Control': 'no-store'
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

type SnapshotSet = {
  runtime: string;
  provider: string;
  scheduler: string;
  error: string;
  runner: string;
  memory: string;
};

function normalizeKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseBulletMap(markdown: string): Record<string, string> {
  const map: Record<string, string> = {};
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+)\s*$/);
    if (!match) continue;
    const key = normalizeKey(match[1] || '');
    const value = (match[2] || '').trim();
    if (!key) continue;
    map[key] = value;
  }
  return map;
}

function parseSchedulerItems(markdown: string): Array<{
  id: number;
  name: string;
  cron: string;
  userId: string;
}> {
  const items: Array<{ id: number; name: string; cron: string; userId: string }> = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s+#(\d+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*user=(.+)\s*$/);
    if (!match) continue;
    items.push({
      id: Number.parseInt(match[1] || '0', 10),
      name: (match[2] || '').trim(),
      cron: (match[3] || '').trim(),
      userId: (match[4] || '').trim()
    });
  }
  return items;
}

function parseErrorIssues(
  markdown: string
): Array<{ at?: string; scope?: string; message: string }> {
  const items: Array<{ at?: string; scope?: string; message: string }> = [];
  const lines = markdown.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\[(.+?)\]\s+\((.+?)\)\s+(.+)$/);
    if (!match) continue;
    items.push({
      at: (match[1] || '').trim(),
      scope: (match[2] || '').trim(),
      message: (match[3] || '').trim()
    });
  }
  return items;
}

function toStructuredStatus(snapshots: SnapshotSet): Record<string, unknown> {
  const runtimeMap = parseBulletMap(snapshots.runtime);
  const providerMap = parseBulletMap(snapshots.provider);
  const schedulerMap = parseBulletMap(snapshots.scheduler);
  const runnerMap = parseBulletMap(snapshots.runner);

  const activeSchedulesRaw = schedulerMap.active_schedules || '0';
  const activeSchedules = Number.parseInt(activeSchedulesRaw, 10);

  return {
    runtime: runtimeMap,
    provider: providerMap,
    scheduler: {
      ...schedulerMap,
      activeSchedules: Number.isFinite(activeSchedules) ? activeSchedules : 0,
      scheduleItems: parseSchedulerItems(snapshots.scheduler)
    },
    error: {
      ...parseBulletMap(snapshots.error),
      recentIssues: parseErrorIssues(snapshots.error)
    },
    runner: runnerMap,
    memory: parseBulletMap(snapshots.memory)
  };
}

function getWebAppHtml(options: WebServerOptions): string {
  const errorThreshold = Number.isFinite(options.alertErrorThreshold)
    ? Math.max(0, Math.floor(options.alertErrorThreshold))
    : 1;
  const runnerWarnThreshold = Number.isFinite(options.alertRunnerSuccessWarnThreshold)
    ? Math.min(100, Math.max(0, options.alertRunnerSuccessWarnThreshold))
    : 80;

  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TeleNexus Local Chat + Dashboard</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap');
      :root {
        --bg: #f0fdfa;
        --card: #ffffff;
        --text: #134e4a;
        --muted: #0f766e;
        --accent: #0d9488;
        --accent-2: #14b8a6;
        --cta: #f97316;
        --line: #99f6e4;
        --chip: #ccfbf1;
        --user: #ccfbf1;
        --model: #fef3c7;
        --danger: #b91c1c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: 'Fira Sans', 'Noto Sans TC', sans-serif;
        color: var(--text);
        background-color: var(--bg);
        background-image: radial-gradient(circle at 1px 1px, rgba(13, 148, 136, 0.12) 1px, transparent 0);
        background-size: 16px 16px;
      }
      .wrap { max-width: 1220px; margin: 20px auto; padding: 0 16px; }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--card);
        padding: 12px 14px;
      }
      .header h1 { margin: 0; font-size: 24px; font-family: 'Fira Code', monospace; letter-spacing: -0.2px; }
      .header p { margin: 4px 0 0; color: var(--muted); }
      .layout { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
      }
      .section-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .section-title h2 { margin: 0; font-size: 17px; }
      .chip {
        display: inline-block;
        font-size: 12px;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--chip);
        color: var(--muted);
        border: 1px solid var(--line);
      }
      #messages {
        height: 430px;
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
        background: #ffffff;
      }
      .m { margin: 6px 0; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; line-height: 1.45; }
      .u { background: var(--user); border-left: 3px solid var(--accent-2); }
      .a { background: var(--model); border-left: 3px solid var(--cta); }
      form { margin-top: 10px; display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      input, button, textarea {
        font: inherit;
        border-radius: 8px;
        border: 1px solid var(--line);
        padding: 9px 10px;
        background: white;
        color: var(--text);
      }
      textarea { width: 100%; min-height: 86px; resize: vertical; }
      button {
        background: var(--accent);
        color: white;
        border: 1px solid transparent;
        cursor: pointer;
        transition: background-color 180ms ease, opacity 180ms ease, border-color 180ms ease;
      }
      button:hover { background: var(--accent-2); }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      button.subtle {
        background: #ecfeff;
        color: #0f766e;
        border-color: var(--line);
      }
      button.subtle:hover { background: #cffafe; }
      input:focus, button:focus, textarea:focus {
        outline: 2px solid var(--cta);
        outline-offset: 1px;
      }
      #status { margin-top: 9px; font-size: 13px; color: var(--muted); }
      .row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
      .stack { display: grid; gap: 10px; }
      .list { border: 1px solid var(--line); border-radius: 10px; background: #ffffff; max-height: 220px; overflow: auto; }
      .item { padding: 10px; border-bottom: 1px dashed var(--line); }
      .item:last-child { border-bottom: none; }
      .meta { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
      pre.snapshot {
        margin: 0;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
        background: #ffffff;
        max-height: 180px;
        overflow: auto;
        font-size: 12px;
        line-height: 1.4;
      }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .metric-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
      .metric {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
        background: #ffffff;
      }
      .metric .k { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
      .metric .v { font-size: 16px; font-weight: bold; letter-spacing: 0.2px; font-family: 'Fira Code', monospace; }
      .metric .sub { margin-top: 6px; color: var(--muted); font-size: 12px; }
      .mini-list { border: 1px solid var(--line); border-radius: 10px; background: #ffffff; margin-bottom: 10px; }
      .mini-item { padding: 8px 10px; border-bottom: 1px dashed var(--line); font-size: 13px; }
      .mini-item:last-child { border-bottom: none; }
      .err { color: var(--danger); }
      .alert-banner {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
        font-size: 13px;
      }
      .alert-banner.hidden { display: none; }
      .alert-banner.danger {
        background: #fee2e2;
        border-color: #fecaca;
        color: #991b1b;
      }
      .alert-banner.warn {
        background: #ffedd5;
        border-color: #fed7aa;
        color: #9a3412;
      }
      .alert-title { font-weight: 600; margin-bottom: 4px; }
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; }
      }
      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; }
        #messages { height: 45vh; }
        .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div id="globalAlert" class="alert-banner hidden">
        <div id="globalAlertTitle" class="alert-title"></div>
        <div id="globalAlertBody"></div>
      </div>

      <div class="header">
        <div>
          <h1>TeleNexus Local Console</h1>
          <p>本地聊天 + Dashboard（與 Telegram 共用記憶與排程）。</p>
        </div>
        <span class="chip" id="serverStatus">connecting...</span>
      </div>

      <div class="layout">
        <div class="card">
          <div class="section-title">
            <h2>Chat</h2>
            <span class="chip">shared user context</span>
          </div>
          <div id="messages"></div>
          <form id="chatForm">
            <input id="chatInput" placeholder="輸入訊息..." autocomplete="off" />
            <button type="submit">送出</button>
          </form>
          <div class="row" style="margin-top: 10px;">
            <input id="tokenInput" placeholder="API token（若有設定 WEB_AUTH_TOKEN）" autocomplete="off" />
            <button type="button" class="subtle" id="saveTokenBtn">儲存 Token</button>
          </div>
          <div id="status">Ready</div>
        </div>

        <div class="stack">
          <div class="card">
            <div class="section-title">
              <h2>Memory Recent</h2>
              <button type="button" class="subtle" id="refreshRecentBtn">刷新</button>
            </div>
            <div id="recentList" class="list"></div>
          </div>

          <div class="card">
            <div class="section-title">
              <h2>Memory Search</h2>
              <button type="button" class="subtle" id="searchMemoryBtn">搜尋</button>
            </div>
            <div class="row" style="margin-bottom: 10px;">
              <input id="searchInput" placeholder="輸入關鍵字，例如 待辦/排程/問題" autocomplete="off" />
              <button type="button" class="subtle" id="clearSearchBtn">清除</button>
            </div>
            <div id="searchResultList" class="list"></div>
          </div>

          <div class="card">
            <div class="section-title">
              <h2>Memory History</h2>
              <button type="button" class="subtle" id="refreshHistoryBtn">刷新</button>
            </div>
            <div class="row" style="margin-bottom: 10px; grid-template-columns: auto auto auto 1fr auto auto;">
              <button type="button" class="subtle" id="historyPrevBtn">上一頁</button>
              <button type="button" class="subtle" id="historyNextBtn">下一頁</button>
              <span class="chip" id="historyPageInfo">page 1</span>
              <span></span>
              <button type="button" class="subtle" id="exportJsonBtn">匯出 JSON</button>
              <button type="button" class="subtle" id="exportCsvBtn">匯出 CSV</button>
            </div>
            <div id="historyList" class="list"></div>
          </div>

          <div class="card">
            <div class="section-title">
              <h2>Schedules</h2>
              <button type="button" class="subtle" id="refreshSchedulesBtn">刷新</button>
            </div>
            <div class="stack" style="margin-bottom: 10px;">
              <input id="scheduleNameInput" placeholder="排程名稱，例如 每日站會" autocomplete="off" />
              <input id="scheduleCronInput" placeholder="Cron，例如 0 9 * * *" autocomplete="off" />
              <textarea id="schedulePromptInput" placeholder="排程提示詞，例如 請整理今日優先待辦與風險"></textarea>
              <div class="row">
                <button type="button" id="addScheduleBtn">新增排程</button>
                <button type="button" class="subtle" id="reloadSchedulesBtn">Reload</button>
              </div>
              <button type="button" class="subtle" id="reflectBtn">手動追蹤分析</button>
            </div>
            <div id="scheduleList" class="list"></div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 14px;">
        <div class="section-title">
          <h2>Status Snapshots</h2>
          <button type="button" class="subtle" id="refreshStatusBtn">刷新</button>
        </div>

        <div class="metric-grid">
          <div class="metric">
            <div class="k">Provider</div>
            <div class="v" id="statProvider">-</div>
            <div class="sub" id="statModel">model: -</div>
          </div>
          <div class="metric">
            <div class="k">Active Schedules</div>
            <div class="v" id="statSchedules">0</div>
            <div class="sub">from scheduler snapshot</div>
          </div>
          <div class="metric">
            <div class="k">Runner Success</div>
            <div class="v" id="statRunnerRate">-</div>
            <div class="sub" id="statRunnerWindow">5m: -</div>
          </div>
          <div class="metric">
            <div class="k">Runtime Updated</div>
            <div class="v" id="statRuntimeUpdated">-</div>
            <div class="sub">runtime-status.md</div>
          </div>
          <div class="metric">
            <div class="k">Recent Errors</div>
            <div class="v" id="statErrorCount">0</div>
            <div class="sub">error-summary.md</div>
          </div>
        </div>

        <div class="meta">Schedule Preview</div>
        <div id="schedulePreview" class="mini-list"></div>

        <div class="grid2">
          <div>
            <div class="meta">runtime-status.md</div>
            <pre class="snapshot" id="runtimeSnapshot"></pre>
          </div>
          <div>
            <div class="meta">scheduler-status.md</div>
            <pre class="snapshot" id="schedulerSnapshot"></pre>
          </div>
          <div>
            <div class="meta">provider-status.md</div>
            <pre class="snapshot" id="providerSnapshot"></pre>
          </div>
          <div>
            <div class="meta">runner-status.md</div>
            <pre class="snapshot" id="runnerSnapshot"></pre>
          </div>
        </div>
      </div>
    </div>

    <script>
      const messages = document.getElementById('messages');
      const form = document.getElementById('chatForm');
      const input = document.getElementById('chatInput');
      const status = document.getElementById('status');
      const globalAlert = document.getElementById('globalAlert');
      const globalAlertTitle = document.getElementById('globalAlertTitle');
      const globalAlertBody = document.getElementById('globalAlertBody');
      const serverStatus = document.getElementById('serverStatus');
      const tokenInput = document.getElementById('tokenInput');
      const saveTokenBtn = document.getElementById('saveTokenBtn');

      const recentList = document.getElementById('recentList');
      const searchInput = document.getElementById('searchInput');
      const searchResultList = document.getElementById('searchResultList');
      const historyList = document.getElementById('historyList');
      const historyPageInfo = document.getElementById('historyPageInfo');
      const scheduleList = document.getElementById('scheduleList');
      const scheduleNameInput = document.getElementById('scheduleNameInput');
      const scheduleCronInput = document.getElementById('scheduleCronInput');
      const schedulePromptInput = document.getElementById('schedulePromptInput');
      const runtimeSnapshot = document.getElementById('runtimeSnapshot');
      const schedulerSnapshot = document.getElementById('schedulerSnapshot');
      const providerSnapshot = document.getElementById('providerSnapshot');
      const runnerSnapshot = document.getElementById('runnerSnapshot');
      const statProvider = document.getElementById('statProvider');
      const statModel = document.getElementById('statModel');
      const statSchedules = document.getElementById('statSchedules');
      const statRunnerRate = document.getElementById('statRunnerRate');
      const statRunnerWindow = document.getElementById('statRunnerWindow');
      const statRuntimeUpdated = document.getElementById('statRuntimeUpdated');
      const statErrorCount = document.getElementById('statErrorCount');
      const schedulePreview = document.getElementById('schedulePreview');

      const refreshRecentBtn = document.getElementById('refreshRecentBtn');
      const searchMemoryBtn = document.getElementById('searchMemoryBtn');
      const clearSearchBtn = document.getElementById('clearSearchBtn');
      const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
      const historyPrevBtn = document.getElementById('historyPrevBtn');
      const historyNextBtn = document.getElementById('historyNextBtn');
      const exportJsonBtn = document.getElementById('exportJsonBtn');
      const exportCsvBtn = document.getElementById('exportCsvBtn');
      const refreshSchedulesBtn = document.getElementById('refreshSchedulesBtn');
      const addScheduleBtn = document.getElementById('addScheduleBtn');
      const reloadSchedulesBtn = document.getElementById('reloadSchedulesBtn');
      const reflectBtn = document.getElementById('reflectBtn');
      const refreshStatusBtn = document.getElementById('refreshStatusBtn');

      const storedToken = window.localStorage.getItem('telenexus_web_token') || '';
      tokenInput.value = storedToken;
      let currentSchedules = [];
      let historyOffset = 0;
      let historyLimit = 10;
      const ERROR_ALERT_THRESHOLD = ${errorThreshold};
      const RUNNER_SUCCESS_WARN_THRESHOLD = ${runnerWarnThreshold};

      function getToken() {
        return (tokenInput.value || '').trim();
      }

      function getApiHeaders(extraHeaders) {
        const headers = Object.assign({}, extraHeaders || {});
        const token = getToken();
        if (token) {
          headers['Authorization'] = 'Bearer ' + token;
        }
        return headers;
      }

      async function apiFetch(path, options) {
        const cfg = Object.assign({}, options || {});
        cfg.headers = getApiHeaders(cfg.headers);
        const res = await fetch(path, cfg);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Request failed: ' + res.status);
        }
        return data;
      }

      function addMessage(text, cls) {
        const div = document.createElement('div');
        div.className = 'm ' + cls;
        div.textContent = text;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      }

      function escapeHtml(text) {
        return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function renderSimpleList(container, items, renderer) {
        container.innerHTML = '';
        if (!items || items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'item';
          empty.textContent = '(none)';
          container.appendChild(empty);
          return;
        }
        items.forEach((item) => {
          const div = document.createElement('div');
          div.className = 'item';
          div.innerHTML = renderer(item);
          container.appendChild(div);
        });
      }

      function fmtTime(ts) {
        try {
          return new Date(ts).toLocaleString('zh-TW');
        } catch {
          return String(ts);
        }
      }

      function parsePercentValue(raw) {
        if (typeof raw !== 'string') return null;
        const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
        if (!m) return null;
        const val = Number.parseFloat(m[1]);
        return Number.isFinite(val) ? val : null;
      }

      function hideGlobalAlert() {
        globalAlert.className = 'alert-banner hidden';
        globalAlertTitle.textContent = '';
        globalAlertBody.textContent = '';
      }

      function showGlobalAlert(level, title, body) {
        globalAlert.className = 'alert-banner ' + level;
        globalAlertTitle.textContent = title;
        globalAlertBody.textContent = body;
      }

      function evaluateGlobalAlert(structured, issueCount) {
        const runner = structured && structured.runner ? structured.runner : {};
        const runnerSuccess = parsePercentValue(runner.success_rate || '');
        const runnerWindow = runner.last_5m_success_rate || '-';

        if (issueCount >= ERROR_ALERT_THRESHOLD) {
          showGlobalAlert(
            'danger',
            'Runtime Alert',
            'Recent runtime issues = ' + issueCount + '，請查看 Error Summary 與 logs。'
          );
          return;
        }

        if (runnerSuccess !== null && runnerSuccess < RUNNER_SUCCESS_WARN_THRESHOLD) {
          showGlobalAlert(
            'warn',
            'Runner Warning',
            'Runner success rate 偏低（' + runnerSuccess + '%，5m=' + runnerWindow + '）。'
          );
          return;
        }

        hideGlobalAlert();
      }

      async function refreshHealth() {
        try {
          await apiFetch('/api/health');
          serverStatus.textContent = 'online';
          serverStatus.style.background = '#ccfbf1';
          serverStatus.style.color = '#115e59';
          serverStatus.style.borderColor = '#5eead4';
        } catch {
          serverStatus.textContent = 'offline';
          serverStatus.style.background = '#fee2e2';
          serverStatus.style.color = '#b91c1c';
          serverStatus.style.borderColor = '#fecaca';
        }
      }

      async function refreshRecent() {
        try {
          const data = await apiFetch('/api/memory/recent?limit=12');
          renderSimpleList(recentList, data.items, (item) => {
            const role = item.role === 'user' ? 'User' : 'AI';
            const text = escapeHtml(item.content || '');
            return '<div class="meta">' + role + ' | ' + fmtTime(item.timestamp) + '</div><div>' + text + '</div>';
          });
        } catch (error) {
          recentList.innerHTML = '<div class="item">讀取失敗：' + error.message + '</div>';
        }
      }

      async function searchMemory() {
        const q = (searchInput.value || '').trim();
        if (!q) {
          searchResultList.innerHTML = '<div class="item">請先輸入關鍵字。</div>';
          return;
        }
        try {
          const data = await apiFetch('/api/memory/search?q=' + encodeURIComponent(q) + '&limit=20');
          renderSimpleList(searchResultList, data.items, (item) => {
            const role = item.role === 'user' ? 'User' : 'AI';
            const text = escapeHtml(item.content || '');
            return '<div class="meta">' + role + ' | ' + fmtTime(item.timestamp) + '</div><div>' + text + '</div>';
          });
        } catch (error) {
          searchResultList.innerHTML = '<div class="item">搜尋失敗：' + error.message + '</div>';
        }
      }

      async function refreshHistory() {
        try {
          const data = await apiFetch(
            '/api/memory/history?offset=' + encodeURIComponent(String(historyOffset)) + '&limit=' + encodeURIComponent(String(historyLimit))
          );

          const total = Number(data.total || 0);
          const offset = Number(data.offset || 0);
          const limit = Number(data.limit || historyLimit);
          const pageNo = Math.floor(offset / limit) + 1;
          const totalPages = Math.max(1, Math.ceil(total / limit));
          historyPageInfo.textContent = 'page ' + pageNo + ' / ' + totalPages + ' | total ' + total;

          renderSimpleList(historyList, data.items, (item) => {
            const role = item.role === 'user' ? 'User' : 'AI';
            const text = escapeHtml(item.content || '');
            return '<div class="meta">' + role + ' | ' + fmtTime(item.timestamp) + '</div><div>' + text + '</div>';
          });

          historyPrevBtn.disabled = offset <= 0;
          historyNextBtn.disabled = !(data.hasMore === true);
        } catch (error) {
          historyList.innerHTML = '<div class="item">讀取失敗：' + error.message + '</div>';
          historyPageInfo.textContent = 'page -';
        }
      }

      function exportMemory(format) {
        const token = getToken();
        const q = token ? '&token=' + encodeURIComponent(token) : '';
        window.open('/api/memory/export?format=' + encodeURIComponent(format) + q, '_blank');
      }

      async function chatWithStream(text) {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: getApiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ message: text })
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Stream request failed: ' + res.status);
        }

        const decoder = new TextDecoder('utf-8');
        const reader = res.body.getReader();
        let buffer = '';
        let aiNode = null;

        const ensureAiNode = () => {
          if (aiNode) return aiNode;
          aiNode = document.createElement('div');
          aiNode.className = 'm a';
          aiNode.textContent = '';
          messages.appendChild(aiNode);
          return aiNode;
        };

        const appendChunk = (chunk) => {
          const node = ensureAiNode();
          const next = node.textContent ? node.textContent + '\\n\\n' + chunk : chunk;
          node.textContent = next;
          messages.scrollTop = messages.scrollHeight;
        };

        const consumeEvent = (rawEvent) => {
          const lines = rawEvent.split('\\n');
          let eventName = 'message';
          let dataText = '';
          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataText += line.slice(5).trim();
            }
          }
          if (!dataText) return;

          let payload = {};
          try {
            payload = JSON.parse(dataText);
          } catch {
            payload = {};
          }

          if (eventName === 'status') {
            status.textContent = payload.text || 'Processing...';
            return;
          }
          if (eventName === 'chunk') {
            appendChunk(payload.text || '');
            status.textContent = 'Streaming...';
            return;
          }
          if (eventName === 'error') {
            throw new Error(payload.error || 'Stream error');
          }
          if (eventName === 'done') {
            if (!aiNode) {
              appendChunk(payload.reply || '(empty)');
            }
            status.textContent = 'Done';
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let splitIndex = buffer.indexOf('\\n\\n');
          while (splitIndex !== -1) {
            const eventText = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);
            consumeEvent(eventText);
            splitIndex = buffer.indexOf('\\n\\n');
          }
        }
      }

      async function refreshSchedules() {
        try {
          const data = await apiFetch('/api/schedules');
          currentSchedules = Array.isArray(data.items) ? data.items : [];
          renderSimpleList(scheduleList, data.items, (item) => {
            const active = item.is_active ? 'active' : 'inactive';
            const title = escapeHtml(item.name || '');
            const cron = escapeHtml(item.cron || '');
            const actionLabel = item.is_active ? '停用' : '啟用';
            return '<div class="meta">#' + item.id + ' | ' + active + '</div>' +
              '<div>' + title + '</div>' +
              '<div class="meta">' + cron + '</div>' +
              '<div class="row" style="margin-top: 8px; grid-template-columns: 1fr 1fr 1fr;">' +
                '<button type="button" class="subtle" data-action="edit" data-id="' + item.id + '">編輯</button>' +
                '<button type="button" class="subtle" data-action="toggle" data-id="' + item.id + '" data-active="' + (item.is_active ? '1' : '0') + '">' + actionLabel + '</button>' +
                '<button type="button" class="subtle" data-action="remove" data-id="' + item.id + '">刪除</button>' +
              '</div>';
          });
        } catch (error) {
          currentSchedules = [];
          scheduleList.innerHTML = '<div class="item">讀取失敗：' + error.message + '</div>';
        }
      }

      async function editSchedule(id) {
        const target = currentSchedules.find((item) => String(item.id) === String(id));
        if (!target) {
          status.textContent = '找不到排程 #' + id;
          return;
        }

        const name = window.prompt('排程名稱', target.name || '');
        if (name === null) return;
        const cron = window.prompt('Cron（5 欄位）', target.cron || '');
        if (cron === null) return;
        const prompt = window.prompt('排程提示詞', target.prompt || '');
        if (prompt === null) return;

        status.textContent = '更新排程中...';
        try {
          await apiFetch('/api/schedules/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              cron: cron.trim(),
              prompt: prompt.trim()
            })
          });
          status.textContent = '排程已更新';
          await Promise.all([refreshSchedules(), refreshSnapshots()]);
        } catch (error) {
          status.textContent = '更新失敗：' + error.message;
        }
      }

      async function createSchedule() {
        const name = (scheduleNameInput.value || '').trim();
        const cron = (scheduleCronInput.value || '').trim();
        const prompt = (schedulePromptInput.value || '').trim();

        if (!name || !cron || !prompt) {
          status.textContent = '請填寫名稱、Cron、提示詞';
          return;
        }

        status.textContent = '新增排程中...';
        try {
          await apiFetch('/api/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, cron, prompt })
          });
          scheduleNameInput.value = '';
          scheduleCronInput.value = '';
          schedulePromptInput.value = '';
          status.textContent = '排程已新增';
          await Promise.all([refreshSchedules(), refreshSnapshots()]);
        } catch (error) {
          status.textContent = '新增失敗：' + error.message;
        }
      }

      async function toggleSchedule(id, currentActiveFlag) {
        const nextActive = currentActiveFlag !== '1';
        status.textContent = '更新排程狀態中...';
        try {
          await apiFetch('/api/schedules/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(id), isActive: nextActive })
          });
          status.textContent = '排程狀態已更新';
          await Promise.all([refreshSchedules(), refreshSnapshots()]);
        } catch (error) {
          status.textContent = '更新失敗：' + error.message;
        }
      }

      async function removeSchedule(id) {
        const ok = window.confirm('確定要刪除排程 #' + id + ' 嗎？');
        if (!ok) return;

        status.textContent = '刪除排程中...';
        try {
          await apiFetch('/api/schedules/' + encodeURIComponent(id), {
            method: 'DELETE'
          });
          status.textContent = '排程已刪除';
          await Promise.all([refreshSchedules(), refreshSnapshots()]);
        } catch (error) {
          status.textContent = '刪除失敗：' + error.message;
        }
      }

      async function reloadSchedules() {
        status.textContent = '重新載入排程中...';
        try {
          await apiFetch('/api/schedules/reload', { method: 'POST' });
          status.textContent = '排程已重新載入';
          await Promise.all([refreshSchedules(), refreshSnapshots()]);
        } catch (error) {
          status.textContent = 'Reload 失敗：' + error.message;
        }
      }

      async function triggerReflect() {
        status.textContent = '執行追蹤分析中...';
        try {
          await apiFetch('/api/reflect', { method: 'POST' });
          status.textContent = '追蹤分析已觸發';
          await Promise.all([refreshRecent(), refreshSnapshots()]);
        } catch (error) {
          status.textContent = '追蹤分析失敗：' + error.message;
        }
      }

      async function refreshSnapshots() {
        try {
          const data = await apiFetch('/api/status');
          const snaps = data.snapshots || {};
          const st = data.structured || {};
          const provider = st.provider || {};
          const scheduler = st.scheduler || {};
          const runner = st.runner || {};
          const runtime = st.runtime || {};
          const error = st.error || {};

          runtimeSnapshot.textContent = snaps.runtime || '(empty)';
          schedulerSnapshot.textContent = snaps.scheduler || '(empty)';
          providerSnapshot.textContent = snaps.provider || '(empty)';
          runnerSnapshot.textContent = snaps.runner || '(empty)';

          statProvider.textContent = provider.provider || '-';
          statModel.textContent = 'model: ' + (provider.model || '-');
          statSchedules.textContent = String(scheduler.activeSchedules || 0);
          statRunnerRate.textContent = runner.success_rate || '-';
          statRunnerWindow.textContent = '5m: ' + (runner.last_5m_success_rate || '-');
          statRuntimeUpdated.textContent = runtime.updated || '-';

          const issues = Array.isArray(error.recentIssues) ? error.recentIssues : [];
          statErrorCount.textContent = String(issues.length);
          statErrorCount.className = issues.length > 0 ? 'v err' : 'v';
          evaluateGlobalAlert(st, issues.length);

          const scheduleItems = Array.isArray(scheduler.scheduleItems) ? scheduler.scheduleItems.slice(0, 5) : [];
          schedulePreview.innerHTML = '';
          if (scheduleItems.length === 0) {
            schedulePreview.innerHTML = '<div class="mini-item">(none)</div>';
          } else {
            scheduleItems.forEach((item) => {
              const div = document.createElement('div');
              div.className = 'mini-item';
              div.textContent = '#' + item.id + ' | ' + item.name + ' | ' + item.cron;
              schedulePreview.appendChild(div);
            });
          }
        } catch (error) {
          runtimeSnapshot.textContent = '讀取失敗：' + error.message;
          schedulerSnapshot.textContent = '';
          providerSnapshot.textContent = '';
          runnerSnapshot.textContent = '';
          statProvider.textContent = '-';
          statModel.textContent = 'model: -';
          statSchedules.textContent = '0';
          statRunnerRate.textContent = '-';
          statRunnerWindow.textContent = '5m: -';
          statRuntimeUpdated.textContent = '-';
          statErrorCount.textContent = '0';
          statErrorCount.className = 'v err';
          schedulePreview.innerHTML = '<div class="mini-item">讀取失敗</div>';
          showGlobalAlert('danger', 'Dashboard Error', '狀態資料讀取失敗，請檢查服務與網路連線。');
        }
      }

      async function refreshAll() {
        await Promise.all([
          refreshHealth(),
          refreshRecent(),
          refreshHistory(),
          refreshSchedules(),
          refreshSnapshots()
        ]);
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        addMessage(text, 'u');
        status.textContent = 'Thinking...';

        try {
          await chatWithStream(text);
          historyOffset = 0;
          await Promise.all([refreshRecent(), refreshHistory(), refreshSchedules()]);
        } catch (error) {
          addMessage('連線失敗：' + error.message, 'a');
          status.textContent = 'Error';
        }
      });

      saveTokenBtn.addEventListener('click', async () => {
        window.localStorage.setItem('telenexus_web_token', getToken());
        status.textContent = 'Token saved';
        await refreshAll();
      });

      refreshRecentBtn.addEventListener('click', () => {
        void refreshRecent();
      });
      refreshHistoryBtn.addEventListener('click', () => {
        void refreshHistory();
      });
      historyPrevBtn.addEventListener('click', () => {
        historyOffset = Math.max(0, historyOffset - historyLimit);
        void refreshHistory();
      });
      historyNextBtn.addEventListener('click', () => {
        historyOffset += historyLimit;
        void refreshHistory();
      });
      exportJsonBtn.addEventListener('click', () => {
        exportMemory('json');
      });
      exportCsvBtn.addEventListener('click', () => {
        exportMemory('csv');
      });
      searchMemoryBtn.addEventListener('click', () => {
        void searchMemory();
      });
      clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchResultList.innerHTML = '<div class="item">請輸入關鍵字後搜尋。</div>';
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void searchMemory();
        }
      });
      refreshSchedulesBtn.addEventListener('click', () => {
        void refreshSchedules();
      });
      addScheduleBtn.addEventListener('click', () => {
        void createSchedule();
      });
      reloadSchedulesBtn.addEventListener('click', () => {
        void reloadSchedules();
      });
      reflectBtn.addEventListener('click', () => {
        void triggerReflect();
      });
      scheduleList.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const button = target.closest('button[data-action]');
        if (!(button instanceof HTMLButtonElement)) return;

        const action = button.dataset.action;
        const id = button.dataset.id;
        if (!action || !id) return;

        if (action === 'toggle') {
          void toggleSchedule(id, button.dataset.active || '0');
          return;
        }
        if (action === 'edit') {
          void editSchedule(id);
          return;
        }
        if (action === 'remove') {
          void removeSchedule(id);
        }
      });
      refreshStatusBtn.addEventListener('click', () => {
        void refreshSnapshots();
      });

      void refreshAll();
      searchResultList.innerHTML = '<div class="item">請輸入關鍵字後搜尋。</div>';
      historyList.innerHTML = '<div class="item">載入中...</div>';
      window.setInterval(() => {
        void refreshAll();
      }, 15000);
    </script>
  </body>
</html>`;
}

export function startWebServer(options: WebServerOptions): WebServerHandle {
  if (!options.enabled) {
    return {
      close: async () => {
        return;
      }
    };
  }

  const defaultConnector = new CaptureConnector();
  const publicDir = resolveWebPublicDir();
  const appStartedAt = Date.now();
  const appVersion = readAppVersion();
  const handleWebMessage = createMessagePipeline({
    connector: defaultConnector,
    resolveConnector: (msg: UnifiedMessage) => {
      const raw = msg.raw as { connector?: Connector } | undefined;
      return raw?.connector || defaultConnector;
    },
    commandRouter: options.commandRouter,
    memory: options.memory,
    scheduler: options.scheduler,
    userAgent: options.userAgent,
    chatRunnerAgent: options.chatRunnerAgent,
    useRunnerForChat: options.useRunnerForChat,
    chatRunnerPercent: options.chatRunnerPercent,
    chatRunnerOnlyUsers: options.chatRunnerOnlyUsers,
    shouldSummarize: options.shouldSummarize,
    buildPrompt: options.buildPrompt,
    ...(options.enqueueMemoriaSync ? { enqueueMemoriaSync: options.enqueueMemoriaSync } : {}),
    recordRuntimeIssue: options.recordRuntimeIssue,
    writeContextSnapshots: options.writeContextSnapshots
  });

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { ok: false, error: 'Missing URL' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${options.host}:${options.port}`}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const indexPath = path.resolve(publicDir, 'index.html');
      try {
        const template = fs.readFileSync(indexPath, 'utf8');
        const html = template.replace('__APP_CONFIG_JSON__', buildAppConfigScript(options));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store'
        });
        res.end(html);
        return;
      } catch {
        const fallback = getWebAppHtml(options);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(fallback),
          'Cache-Control': 'no-store'
        });
        res.end(fallback);
        return;
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/app/')) {
      const decodedPath = decodeURIComponent(url.pathname);
      const requestedPath = path.resolve(publicDir, `.${decodedPath}`);
      if (!requestedPath.startsWith(publicDir)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }
      if (serveStaticFile(res, requestedPath)) {
        return;
      }
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    // debug/version 需要嚴格授權（不信任內網）
    if (req.method === 'GET' && url.pathname === '/api/debug/version') {
      if (!isAuthorized(req, options.authToken, url.searchParams.get('token'), false)) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        version: appVersion,
        pid: process.pid,
        startedAt: appStartedAt,
        uptimeSec: Math.floor((Date.now() - appStartedAt) / 1000),
        nodeEnv: process.env.NODE_ENV || 'unknown',
        gitSha: process.env.APP_GIT_SHA || 'unknown',
        buildTime: process.env.APP_BUILD_TIME || 'unknown'
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (
        !isAuthorized(
          req,
          options.authToken,
          url.searchParams.get('token'),
          options.trustPrivateNetwork
        )
      ) {
        sendJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'telenexus-web',
        host: options.host,
        port: options.port,
        timestamp: Date.now()
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      try {
        const parsed = await readJsonBody<{ message?: string }>(req);
        const message = parsed.message?.trim() || '';
        if (!message) {
          sendJson(res, 400, { ok: false, error: 'message is required' });
          return;
        }

        const connector = new CaptureConnector();
        const unifiedMessage: UnifiedMessage = {
          id: randomUUID(),
          content: message,
          sender: {
            id: options.defaultUserId,
            name: 'Local Web User',
            platform: 'console'
          },
          timestamp: Date.now(),
          raw: { connector }
        };

        await handleWebMessage(unifiedMessage);
        sendJson(res, 200, {
          ok: true,
          reply: connector.getFinalMessage(),
          outputs: connector.getAllMessages()
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat/stream') {
      let keepalive: NodeJS.Timeout | null = null;
      try {
        const parsed = await readJsonBody<{ message?: string }>(req);
        const message = parsed.message?.trim() || '';
        if (!message) {
          sendJson(res, 400, { ok: false, error: 'message is required' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });

        writeSseEvent(res, 'start', { ok: true, timestamp: Date.now() });
        writeSseEvent(res, 'status', { text: 'Thinking...' });
        keepalive = setInterval(() => {
          writeSseEvent(res, 'status', { text: 'Processing...' });
        }, 3500);

        const connector = new CaptureConnector();
        const unifiedMessage: UnifiedMessage = {
          id: randomUUID(),
          content: message,
          sender: {
            id: options.defaultUserId,
            name: 'Local Web User',
            platform: 'console'
          },
          timestamp: Date.now(),
          raw: { connector }
        };

        await handleWebMessage(unifiedMessage);
        const reply = connector.getFinalMessage();
        const chunks = splitStreamChunks(reply);

        for (let i = 0; i < chunks.length; i += 1) {
          writeSseEvent(res, 'chunk', {
            index: i,
            total: chunks.length,
            text: chunks[i]
          });
          if (i < chunks.length - 1) {
            await sleep(25);
          }
        }

        writeSseEvent(res, 'done', {
          ok: true,
          reply,
          outputs: connector.getAllMessages()
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          writeSseEvent(res, 'error', { ok: false, error: message });
        } catch {
          // ignore stream write failures
        }
      } finally {
        if (keepalive) {
          clearInterval(keepalive);
        }
        try {
          res.end();
        } catch {
          // ignore close failures
        }
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory/stats') {
      const stats = options.memory.getStats(options.defaultUserId);
      sendJson(res, 200, { ok: true, stats });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory-health') {
      sendJson(res, 200, { ok: true, report: collectMemoryHealthReport() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory-backfill/report') {
      const limit = Number.parseInt(url.searchParams.get('limit') || '10', 10);
      sendJson(res, 200, { ok: true, items: getRecentMemoryBackfillReports(limit) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory/history') {
      const offset = parseOffset(url.searchParams.get('offset'), 0);
      const limit = parseLimit(url.searchParams.get('limit'), 20, 200);
      const beforeTimestampRaw = url.searchParams.get('beforeTimestamp');
      const beforeTimestamp = beforeTimestampRaw ? Number.parseInt(beforeTimestampRaw, 10) : NaN;

      if (Number.isFinite(beforeTimestamp) && beforeTimestamp > 0) {
        const page = options.memory.getMessagesBefore(
          options.defaultUserId,
          beforeTimestamp,
          limit
        );
        sendJson(res, 200, {
          ok: true,
          items: page.items,
          total: page.total,
          offset: 0,
          limit: page.limit,
          hasMore: page.hasMore,
          nextBeforeTimestamp: page.nextBeforeTimestamp
        });
        return;
      }

      const page = options.memory.getMessagesPage(options.defaultUserId, offset, limit);
      sendJson(res, 200, {
        ok: true,
        ...page,
        hasMore: page.offset + page.items.length < page.total
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory/export') {
      const format = (url.searchParams.get('format') || 'json').trim().toLowerCase();
      const page = options.memory.getMessagesPage(options.defaultUserId, 0, 5000);

      if (format === 'csv') {
        const lines = ['timestamp,role,content'];
        for (const item of page.items) {
          lines.push(`${item.timestamp},${escapeCsv(item.role)},${escapeCsv(item.content || '')}`);
        }
        const csv = lines.join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="memory-export.csv"',
          'Content-Length': Buffer.byteLength(csv)
        });
        res.end(csv);
        return;
      }

      const payload = JSON.stringify(
        {
          exportedAt: Date.now(),
          userId: options.defaultUserId,
          total: page.total,
          items: page.items
        },
        null,
        2
      );
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="memory-export.json"',
        'Content-Length': Buffer.byteLength(payload)
      });
      res.end(payload);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory/stream') {
      let monitor: NodeJS.Timeout | null = null;
      let keepalive: NodeJS.Timeout | null = null;
      let closed = false;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (monitor) {
          clearInterval(monitor);
          monitor = null;
        }
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
        try {
          res.end();
        } catch {
          // ignore close failures
        }
      };

      try {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        });

        let previous = options.memory.getStats(options.defaultUserId);
        writeSseEvent(res, 'snapshot', {
          ok: true,
          totalMessages: previous.totalMessages,
          lastActive: previous.lastActive,
          timestamp: Date.now()
        });

        monitor = setInterval(() => {
          const current = options.memory.getStats(options.defaultUserId);
          if (
            current.totalMessages !== previous.totalMessages ||
            current.lastActive !== previous.lastActive
          ) {
            previous = current;
            writeSseEvent(res, 'update', {
              ok: true,
              totalMessages: current.totalMessages,
              lastActive: current.lastActive,
              timestamp: Date.now()
            });
          }
        }, 2000);

        keepalive = setInterval(() => {
          writeSseEvent(res, 'ping', { timestamp: Date.now() });
        }, 15000);

        req.on('close', closeStream);
        req.on('aborted', closeStream);
      } catch {
        closeStream();
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory/recent') {
      const limit = parseLimit(url.searchParams.get('limit'), 20, 200);
      const items = options.memory.getRecentMessages(options.defaultUserId, limit);
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/memory/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const limit = parseLimit(url.searchParams.get('limit'), 20, 100);
      if (!q) {
        sendJson(res, 400, { ok: false, error: 'q is required' });
        return;
      }
      const items = options.memory.search(options.defaultUserId, q, limit);
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      const items = options.memory.getUserSchedules(options.defaultUserId);
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/schedules') {
      try {
        const parsed = await readJsonBody<{
          name?: string;
          cron?: string;
          prompt?: string;
        }>(req);
        const name = parsed.name?.trim() || '';
        const cron = parsed.cron?.trim() || '';
        const prompt = parsed.prompt?.trim() || '';

        if (!name || !cron || !prompt) {
          sendJson(res, 400, { ok: false, error: 'name, cron, prompt are required' });
          return;
        }

        const id = options.scheduler.addSchedule(options.defaultUserId, name, cron, prompt);
        sendJson(res, 200, {
          ok: true,
          id,
          schedule: {
            id,
            user_id: options.defaultUserId,
            name,
            cron,
            prompt,
            is_active: true,
            created_at: Date.now()
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'PUT' && /^\/api\/schedules\/\d+$/.test(url.pathname)) {
      try {
        const rawId = url.pathname.split('/').pop() || '';
        const id = Number.parseInt(rawId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          sendJson(res, 400, { ok: false, error: 'Invalid schedule id' });
          return;
        }

        const parsed = await readJsonBody<{
          name?: string;
          cron?: string;
          prompt?: string;
        }>(req);
        const name = parsed.name?.trim() || '';
        const cron = parsed.cron?.trim() || '';
        const prompt = parsed.prompt?.trim() || '';
        if (!name || !cron || !prompt) {
          sendJson(res, 400, { ok: false, error: 'name, cron, prompt are required' });
          return;
        }

        const schedule = options.scheduler.updateSchedule(
          options.defaultUserId,
          id,
          name,
          cron,
          prompt
        );
        sendJson(res, 200, { ok: true, schedule });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'DELETE' && /^\/api\/schedules\/\d+$/.test(url.pathname)) {
      try {
        const rawId = url.pathname.split('/').pop() || '';
        const id = Number.parseInt(rawId, 10);
        if (!Number.isFinite(id) || id <= 0) {
          sendJson(res, 400, { ok: false, error: 'Invalid schedule id' });
          return;
        }

        options.scheduler.removeSchedule(id);
        sendJson(res, 200, { ok: true, id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/schedules/toggle') {
      try {
        const parsed = await readJsonBody<{ id?: number; isActive?: boolean }>(req);
        const id = parsed.id;
        const isActive = parsed.isActive;
        if (!Number.isFinite(id) || typeof isActive !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'id(number) and isActive(boolean) are required' });
          return;
        }

        const scheduleId = Number(id);

        options.memory.toggleSchedule(scheduleId, isActive);
        await options.scheduler.reload();
        sendJson(res, 200, { ok: true, id: scheduleId, isActive });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/schedules/reload') {
      try {
        await options.scheduler.reload();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/reflect') {
      try {
        await options.scheduler.triggerReflection(options.defaultUserId, 'manual');
        sendJson(res, 200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { ok: false, error: message });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const snapshots: SnapshotSet = {
        runtime: readContextFile('runtime-status.md'),
        provider: readContextFile('provider-status.md'),
        scheduler: readContextFile('scheduler-status.md'),
        error: readContextFile('error-summary.md'),
        runner: readContextFile('runner-status.md'),
        memory: readContextFile('memory-status.md')
      };
      sendJson(res, 200, {
        ok: true,
        snapshots,
        structured: toStructuredStatus(snapshots)
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  });

  server.listen(options.port, options.host, () => {
    console.log(`[Web] Local server listening at http://${options.host}:${options.port}`);
  });

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}
