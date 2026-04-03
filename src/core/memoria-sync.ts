import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue, toErrorMessage } from '../utils/errors.js';

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
};

export type MemoriaSyncStatus = {
  mode: MemoriaSyncMode;
  available: boolean;
  disabled: boolean;
  cliDetected: boolean;
  memoriaHome: string;
  cliPath: string;
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

function buildEvents(turn: MemoriaSyncTurn): SessionEvent[] {
  const now = new Date().toISOString();
  return [
    {
      id: randomUUID(),
      timestamp: now,
      type: 'UserMessage',
      content: {
        role: 'user',
        text: turn.userMessage
      },
      metadata: {
        source: 'telenexus',
        user_id: turn.userId,
        platform: turn.platform || 'telegram',
        is_passthrough_command: turn.isPassthroughCommand,
        force_new_session: turn.forceNewSession
      }
    },
    {
      id: randomUUID(),
      timestamp: now,
      type: 'ModelMessage',
      content: {
        role: 'model',
        text: turn.modelMessage
      },
      metadata: {
        source: 'telenexus',
        user_id: turn.userId,
        platform: turn.platform || 'telegram',
        is_passthrough_command: turn.isPassthroughCommand,
        force_new_session: turn.forceNewSession
      }
    }
  ];
}

function runOneSyncCommand(
  command: string,
  args: string[],
  memoriaHome: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: memoriaHome,
      env: {
        ...process.env,
        MEMORIA_HOME: memoriaHome
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`memoria sync timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`exit=${code}: ${stderr || stdout || '(empty)'}`));
    });
  });
}

async function runMemoriaSync(
  cliPath: string,
  memoriaHome: string,
  payloadPath: string,
  timeoutMs: number
): Promise<void> {
  const fallbackTsxCli = path.join(memoriaHome, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const attempts: Array<{ command: string; args: string[]; name: string }> = [
    { command: cliPath, args: ['sync', payloadPath], name: 'cli shim' }
  ];

  if (fs.existsSync(fallbackTsxCli)) {
    attempts.push({
      command: 'node',
      args: [fallbackTsxCli, 'src/cli.ts', 'sync', payloadPath],
      name: 'node+tsx fallback'
    });
  }

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      await runOneSyncCommand(attempt.command, attempt.args, memoriaHome, timeoutMs);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = new Error(`${attempt.name} failed: ${message}`);
    }
  }

  throw lastError || new Error('memoria sync failed');
}

export class MemoriaSyncBridge {
  private readonly mode: MemoriaSyncMode;
  private readonly timeoutMs: number;
  private readonly projectDir: string;
  private readonly memoriaHome: string;
  private readonly cliPath: string;
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
  private cliDetected: boolean;
  private recentFailureCount: number;
  private lastSyncAt: number | null;
  private lastFailureAt: number | null;
  private lastFailureMessage: string | null;

  constructor(options: MemoriaSyncOptions = {}) {
    this.mode = options.mode || parseMode(process.env.MEMORIA_SYNC_ENABLED);
    this.timeoutMs =
      options.timeoutMs || parsePositiveInt(process.env.MEMORIA_SYNC_TIMEOUT_MS, 20000);
    this.projectDir = path.resolve(
      options.projectDir || process.env.GEMINI_PROJECT_DIR || process.cwd()
    );
    this.memoriaHome = path.resolve(
      process.env.MEMORIA_HOME || path.join(this.projectDir, 'workspace', 'Memoria')
    );
    this.cliPath = path.resolve(process.env.MEMORIA_CLI_PATH || path.join(this.memoriaHome, 'cli'));
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
    this.cliDetected = fs.existsSync(this.cliPath);
    this.recentFailureCount = 0;
    this.lastSyncAt = null;
    this.lastFailureAt = null;
    this.lastFailureMessage = null;

    if (this.mode === 'off') {
      console.log('[MemoriaSync] Disabled by MEMORIA_SYNC_ENABLED.');
      this.disabled = true;
      return;
    }

    if (!this.cliDetected) {
      const message = `[MemoriaSync] CLI not found: ${this.cliPath}`;
      if (this.mode === 'on') {
        console.warn(`${message} (mode=on, will keep retrying queue)`);
      } else {
        console.log(`${message} (mode=auto, disabled)`);
        this.disabled = true;
      }
      return;
    }

    try {
      ensureDir(this.tempDir);
      ensureDir(this.failedDir);
      if (this.hookQueueEnabled) {
        ensureDir(path.dirname(this.hookQueueFile));
      }
      console.log(`[MemoriaSync] Enabled. memoriaHome=${this.memoriaHome}`);
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
          summary: `user=${turn.userId} platform=${turn.platform || 'telegram'} source=${source} passthrough=${turn.isPassthroughCommand}`,
          events: buildEvents(turn)
        };

        const payloadPath = path.join(this.tempDir, `${sessionId}.json`);
        fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
        let synced = false;

        try {
          await runMemoriaSync(this.cliPath, this.memoriaHome, payloadPath, this.timeoutMs);
          synced = true;
          this.recentFailureCount = 0;
          this.lastFailureMessage = null;
          this.lastFailureAt = null;
          this.lastSyncAt = Date.now();
          console.log(`[MemoriaSync] Synced session ${sessionId}`);
        } catch (error) {
          this.recentFailureCount += 1;
          this.lastFailureAt = Date.now();
          this.lastFailureMessage = toErrorMessage(error);
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
              userId: typeof parsed.userId === 'string' ? parsed.userId : 'gemini-hook',
              userMessage,
              modelMessage,
              platform: typeof parsed.platform === 'string' ? parsed.platform : 'gemini-hook',
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
      available: !this.disabled && this.cliDetected,
      disabled: this.disabled,
      cliDetected: this.cliDetected,
      memoriaHome: this.memoriaHome,
      cliPath: this.cliPath,
      hookQueueEnabled: this.hookQueueEnabled,
      hookQueuePollMs: this.hookQueuePollMs,
      recentFailureCount: this.recentFailureCount,
      lastSyncAt: this.lastSyncAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureMessage: this.lastFailureMessage
    };
  }
}
