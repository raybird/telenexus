import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue, toErrorMessage } from '../utils/errors.js';
import { getMemoriaEndpoint, pingMemoriaEndpoint, rememberViaHttp } from './memoria-recall.js';

export type MemoriaSyncTurn = {
  userId: string;
  userMessage: string;
  modelMessage: string;
  platform?: string;
  isPassthroughCommand: boolean;
  forceNewSession: boolean;
};

type MemoriaSyncMode = 'on' | 'off' | 'auto';

type MemoriaSyncOptions = {
  projectDir?: string;
  mode?: MemoriaSyncMode;
  timeoutMs?: number;
  onStatusChange?: (status: MemoriaSyncStatus) => void;
};

export type MemoriaSyncStatus = {
  mode: MemoriaSyncMode;
  available: boolean;
  disabled: boolean;
  endpointReachable: boolean;
  endpoint: string;
  hookQueueEnabled: boolean;
  hookQueuePollMs: number;
  recentFailureCount: number;
  lastSyncAt: number | null;
  lastFailureAt: number | null;
  lastFailureMessage: string | null;
};

type HookQueuedTurn = {
  userId?: string;
  userMessage?: string;
  modelMessage?: string;
  platform?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
};

type SessionEvent = {
  id: string;
  timestamp: string;
  type: string;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function parseMode(raw: string | undefined): MemoriaSyncMode {
  const normalized = (raw || 'auto').trim().toLowerCase();
  if (normalized === 'on' || normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return 'on';
  }
  if (normalized === 'off' || normalized === 'false' || normalized === '0' || normalized === 'no') {
    return 'off';
  }
  return 'auto';
}

function ensureDir(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
}

/** summary 每一邊的字數上限:要夠長才搜得到,又不必把整輪對話塞進索引。 */
const SUMMARY_SIDE_CHAR_LIMIT = 240;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForSummary(text: string): string {
  const collapsed = collapseWhitespace(text);
  return collapsed.length <= SUMMARY_SIDE_CHAR_LIMIT
    ? collapsed
    : `${collapsed.slice(0, SUMMARY_SIDE_CHAR_LIMIT - 1)}…`;
}

/**
 * Memoria 的關鍵字召回語料只有 sessions.summary + DecisionMade/SkillLearned 事件,
 * 而我們只送 UserMessage/ModelMessage —— summary 是唯一搜得到的欄位。
 * 先前這裡放的是 `user=… platform=…` 這種 metadata,等於整個語料沒有內容可搜;
 * 診斷欄位改放在每個事件的 metadata 裡,不佔用這條唯一的檢索路徑。
 */
function buildSummary(turn: MemoriaSyncTurn): string {
  const user = truncateForSummary(turn.userMessage);
  const model = truncateForSummary(turn.modelMessage);
  return model ? `${user} → ${model}` : user;
}

/**
 * 排程產出寫進獨立分區。
 *
 * Memoria 的 scope 是等值比對,而聊天召回只查 `user:<id>`(prompt/builder.ts) ——
 * 把週期性的排程報告分到 `scheduler:<id>`,它們就永遠不會擠掉真人對話的召回名額,
 * 內容卻完整保留、之後想查換個 scope 就有。實測正式資料:905 筆記憶裡 752 筆是排程,
 * 且只有 5 種任務(光 Crypto Monitor 就 548 筆),不分區的話真人對話會被 5:1 稀釋。
 *
 * 只有 scheduler 走另一區;console / telegram 都是真人對話,一律 `user:<id>`。
 */
function buildScope(turn: MemoriaSyncTurn): string {
  return turn.platform === 'scheduler' ? `scheduler:${turn.userId}` : `user:${turn.userId}`;
}

function buildEvents(turn: MemoriaSyncTurn, source: 'pipeline' | 'hook'): SessionEvent[] {
  const now = new Date().toISOString();
  const metadata = {
    source: 'telenexus',
    sync_source: source,
    user_id: turn.userId,
    platform: turn.platform || 'telegram',
    is_passthrough_command: turn.isPassthroughCommand,
    force_new_session: turn.forceNewSession
  };
  return [
    {
      id: randomUUID(),
      timestamp: now,
      type: 'UserMessage',
      content: {
        role: 'user',
        text: turn.userMessage
      },
      metadata
    },
    {
      id: randomUUID(),
      timestamp: now,
      type: 'ModelMessage',
      content: {
        role: 'model',
        text: turn.modelMessage
      },
      metadata
    }
  ];
}


export class MemoriaSyncBridge {
  private readonly mode: MemoriaSyncMode;
  private readonly timeoutMs: number;
  private readonly projectDir: string;
  private readonly endpoint: string;
  private readonly tempDir: string;
  private readonly failedDir: string;
  private readonly hookQueueFile: string;
  private readonly hookFlushSignalFile: string;
  private readonly hookQueuePollMs: number;
  private readonly hookQueueEnabled: boolean;
  private queue: Promise<void>;
  private disabled: boolean;
  private hookPollTimer: NodeJS.Timeout | null;
  private recentTurnHashes: Map<string, number>;
  private endpointReachable: boolean;
  private recentFailureCount: number;
  private lastSyncAt: number | null;
  private lastFailureAt: number | null;
  private lastFailureMessage: string | null;
  private readonly onStatusChange: ((status: MemoriaSyncStatus) => void) | undefined;

  constructor(options: MemoriaSyncOptions = {}) {
    this.mode = options.mode || parseMode(process.env.MEMORIA_SYNC_ENABLED);
    this.timeoutMs =
      options.timeoutMs || parsePositiveInt(process.env.MEMORIA_SYNC_TIMEOUT_MS, 20000);
    this.projectDir = path.resolve(
      options.projectDir || process.env.APP_PROJECT_DIR || process.cwd()
    );
    this.endpoint = getMemoriaEndpoint();
    this.tempDir = path.resolve(
      process.env.MEMORIA_SYNC_TEMP_DIR ||
        path.join(this.projectDir, 'workspace', 'temp', 'memoria-sync')
    );
    this.failedDir = path.resolve(
      process.env.MEMORIA_SYNC_FAILED_DIR || path.join(this.tempDir, 'failed')
    );
    this.hookQueueFile = path.resolve(
      process.env.MEMORIA_HOOK_QUEUE_FILE ||
        path.join(this.projectDir, 'data', 'memoria-hook-queue.jsonl')
    );
    this.hookFlushSignalFile = path.resolve(
      process.env.MEMORIA_HOOK_FLUSH_SIGNAL ||
        path.join(this.projectDir, 'data', 'memoria-hook-flush.signal')
    );
    this.hookQueuePollMs = parsePositiveInt(process.env.MEMORIA_HOOK_QUEUE_POLL_MS, 5000);
    this.hookQueueEnabled = parseBool(process.env.MEMORIA_HOOK_QUEUE_ENABLED, false);
    this.queue = Promise.resolve();
    this.disabled = false;
    this.hookPollTimer = null;
    this.recentTurnHashes = new Map();
    this.endpointReachable = false;
    this.recentFailureCount = 0;
    this.lastSyncAt = null;
    this.lastFailureAt = null;
    this.lastFailureMessage = null;
    this.onStatusChange = options.onStatusChange;

    if (this.mode === 'off') {
      console.log('[MemoriaSync] Disabled by MEMORIA_SYNC_ENABLED.');
      this.disabled = true;
      return;
    }

    try {
      ensureDir(this.tempDir);
      ensureDir(this.failedDir);
      if (this.hookQueueEnabled) {
        ensureDir(path.dirname(this.hookQueueFile));
      }
      console.log(`[MemoriaSync] Enabled. endpoint=${this.endpoint}`);
      // 背景探測 endpoint 可達性(僅供觀測;不可達不停用,交由 queue 重試)。
      void this.refreshEndpointReachable();
      if (this.hookQueueEnabled) {
        this.startHookQueuePolling();
      } else {
        console.log('[MemoriaSync] Hook queue polling disabled (hook-free mode).');
      }
    } catch (error) {
      console.warn('[MemoriaSync] Failed to prepare temp dir, disabling:', error);
      this.disabled = true;
    }
  }

  private async refreshEndpointReachable(): Promise<void> {
    const reachable = await pingMemoriaEndpoint({ endpoint: this.endpoint });
    if (reachable !== this.endpointReachable) {
      this.endpointReachable = reachable;
      this.notifyStatusChange();
    }
  }

  enqueueTurn(turn: MemoriaSyncTurn): void {
    this.enqueueSyncTurn(turn, 'pipeline');
  }

  private enqueueSyncTurn(turn: MemoriaSyncTurn, source: 'pipeline' | 'hook'): void {
    if (this.disabled) {
      return;
    }

    if (!turn.userMessage.trim() || !turn.modelMessage.trim()) {
      return;
    }

    if (this.isDuplicateTurn(turn)) {
      return;
    }

    this.queue = this.queue
      .then(async () => {
        const timestamp = Date.now();
        const sessionId = `telenexus_${timestamp}_${randomUUID().slice(0, 8)}`;
        const payload = {
          id: sessionId,
          timestamp: new Date(timestamp).toISOString(),
          project: 'TeleNexus',
          // 先前沒帶 scope 會被預設成 project:TeleNexus,而召回端傳 `user:<id>`,
          // 於是每次召回都必定 0 筆。分區規則見 buildScope。
          scope: buildScope(turn),
          summary: buildSummary(turn),
          events: buildEvents(turn, source)
        };

        // 先把 payload 落地當離線緩衝;POST 成功才刪,失敗則保留在 failedDir 供查/重灌。
        const payloadPath = path.join(this.tempDir, `${sessionId}.json`);
        fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
        let synced = false;

        try {
          await rememberViaHttp(payload, { endpoint: this.endpoint, timeoutMs: this.timeoutMs });
          synced = true;
          this.endpointReachable = true;
          this.recentFailureCount = 0;
          this.lastFailureMessage = null;
          this.lastFailureAt = null;
          this.lastSyncAt = Date.now();
          this.notifyStatusChange();
          console.log(`[MemoriaSync] Synced session ${sessionId}`);
        } catch (error) {
          this.endpointReachable = false;
          this.recentFailureCount += 1;
          this.lastFailureAt = Date.now();
          this.lastFailureMessage = toErrorMessage(error);
          this.notifyStatusChange();
          const failedPath = this.preserveFailedPayload(payloadPath, sessionId);
          const details = failedPath
            ? `${toErrorMessage(error)} (payload preserved: ${failedPath})`
            : `${toErrorMessage(error)} (payload retained at ${payloadPath})`;
          recordRuntimeIssue('memoria-sync', details);
          throw new Error(details);
        } finally {
          if (synced) {
            try {
              fs.unlinkSync(payloadPath);
            } catch {
              // ignore cleanup failure
            }
          }
        }
      })
      .catch((error) => {
        console.warn('[MemoriaSync] Sync failed:', error);
      });
  }

  whenIdle(): Promise<void> {
    return this.queue.catch(() => undefined);
  }

  private makeTurnHash(turn: MemoriaSyncTurn): string {
    const normalized = `${turn.userMessage.trim()}\n---\n${turn.modelMessage.trim()}`;
    return createHash('sha256').update(normalized).digest('hex');
  }

  private preserveFailedPayload(payloadPath: string, sessionId: string): string | null {
    if (!fs.existsSync(payloadPath)) {
      return null;
    }

    ensureDir(this.failedDir);
    const failedPath = path.join(this.failedDir, `${sessionId}.json`);
    try {
      fs.renameSync(payloadPath, failedPath);
      return failedPath;
    } catch {
      return null;
    }
  }

  private isDuplicateTurn(turn: MemoriaSyncTurn): boolean {
    const now = Date.now();
    const ttlMs = 10 * 60 * 1000;
    const hash = this.makeTurnHash(turn);

    for (const [key, ts] of this.recentTurnHashes.entries()) {
      if (now - ts > ttlMs) {
        this.recentTurnHashes.delete(key);
      }
    }

    if (this.recentTurnHashes.has(hash)) {
      return true;
    }

    this.recentTurnHashes.set(hash, now);
    return false;
  }

  private startHookQueuePolling(): void {
    this.drainHookQueue();
    this.hookPollTimer = setInterval(() => {
      this.drainHookQueue();
    }, this.hookQueuePollMs);
    this.hookPollTimer.unref();
  }

  private drainHookQueue(): void {
    if (this.disabled) {
      return;
    }

    this.queue = this.queue
      .then(() => {
        const flushRequested = fs.existsSync(this.hookFlushSignalFile);
        if (flushRequested) {
          try {
            fs.unlinkSync(this.hookFlushSignalFile);
          } catch {
            // ignore signal cleanup errors
          }
        }

        if (!fs.existsSync(this.hookQueueFile)) {
          return;
        }

        const stat = fs.statSync(this.hookQueueFile);
        if (stat.size <= 0) {
          return;
        }

        const processingPath = `${this.hookQueueFile}.${Date.now()}.processing`;
        fs.renameSync(this.hookQueueFile, processingPath);
        const raw = fs.readFileSync(processingPath, 'utf8');
        fs.unlinkSync(processingPath);

        const lines = raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        let imported = 0;
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as HookQueuedTurn;
            const userMessage = typeof parsed.userMessage === 'string' ? parsed.userMessage : '';
            const modelMessage = typeof parsed.modelMessage === 'string' ? parsed.modelMessage : '';
            if (!userMessage || !modelMessage) {
              continue;
            }

            const turn: MemoriaSyncTurn = {
              userId: typeof parsed.userId === 'string' ? parsed.userId : 'unknown',
              userMessage,
              modelMessage,
              platform: typeof parsed.platform === 'string' ? parsed.platform : 'unknown',
              isPassthroughCommand: parsed.isPassthroughCommand === true,
              forceNewSession: parsed.forceNewSession === true
            };
            this.enqueueSyncTurn(turn, 'hook');
            imported += 1;
          } catch (error) {
            console.warn('[MemoriaSync] Invalid hook queue line skipped:', error);
          }
        }

        if (flushRequested || imported > 0) {
          console.log(`[MemoriaSync] Hook queue imported: ${imported}`);
        }
      })
      .catch((error) => {
        console.warn('[MemoriaSync] Hook queue drain failed:', error);
      });
  }

  getStatus(): MemoriaSyncStatus {
    return {
      mode: this.mode,
      available: !this.disabled,
      disabled: this.disabled,
      endpointReachable: this.endpointReachable,
      endpoint: this.endpoint,
      hookQueueEnabled: this.hookQueueEnabled,
      hookQueuePollMs: this.hookQueuePollMs,
      recentFailureCount: this.recentFailureCount,
      lastSyncAt: this.lastSyncAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureMessage: this.lastFailureMessage
    };
  }

  private notifyStatusChange(): void {
    try {
      this.onStatusChange?.(this.getStatus());
    } catch (error) {
      console.warn('[MemoriaSync] Status change hook failed:', error);
    }
  }
}
