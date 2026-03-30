import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import type { MemoryBackfillReport } from './memory-backfill.js';
import {
  resolveMemoryBackfillCheckpointPath,
  resolveMemoriaSessionsDbPath
} from '../utils/paths.js';

export type MemoryBackfillWorkerOptions = {
  intervalMs?: number;
  enabled?: boolean;
  dryRun?: boolean;
  batchSize?: number;
  maxCandidates?: number;
  startupDelayMs?: number;
  timeoutMs?: number;
  onAfterRun?: () => void;
  runBackfill?: () => Promise<MemoryBackfillReport>;
  hasPendingArchiveSessions?: () => boolean;
};

type BackfillCheckpoint = {
  lastProcessedTimestamp?: string;
};

function getIntervalMs(): number {
  return parsePositiveInt(process.env.MEMORY_BACKFILL_INTERVAL_MS, 300000);
}

function getStartupDelayMs(): number {
  const raw = process.env.MEMORY_BACKFILL_STARTUP_DELAY_MS?.trim();
  if (!raw) {
    return 15000;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 15000;
  }
  return parsed;
}

function getTimeoutMs(): number {
  return parsePositiveInt(process.env.MEMORY_BACKFILL_TIMEOUT_MS, 60000);
}

function readCheckpoint(checkpointPath: string): BackfillCheckpoint | null {
  try {
    if (!fs.existsSync(checkpointPath)) {
      return null;
    }
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as BackfillCheckpoint;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function defaultHasPendingArchiveSessions(): boolean {
  const archiveDbPath = resolveMemoriaSessionsDbPath();
  if (!fs.existsSync(archiveDbPath)) {
    return false;
  }

  const checkpoint = readCheckpoint(resolveMemoryBackfillCheckpointPath());
  const db = new Database(archiveDbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`SELECT MAX(timestamp) as last_timestamp FROM sessions`).get() as
      | { last_timestamp?: string | null }
      | undefined;
    const latestTimestamp = row?.last_timestamp?.trim() || null;
    if (!latestTimestamp) {
      return false;
    }
    const checkpointTimestamp = checkpoint?.lastProcessedTimestamp?.trim();
    if (!checkpointTimestamp) {
      return true;
    }
    return latestTimestamp > checkpointTimestamp;
  } finally {
    db.close();
  }
}

function resolveBackfillCliEntry(): string {
  const jsPath = fileURLToPath(new URL('../tools/memory-backfill-cli.js', import.meta.url));
  if (fs.existsSync(jsPath)) {
    return jsPath;
  }
  return fileURLToPath(new URL('../tools/memory-backfill-cli.ts', import.meta.url));
}

function defaultRunBackfill(
  dryRun: boolean,
  batchSize: number,
  maxCandidates: number,
  timeoutMs: number
): Promise<MemoryBackfillReport> {
  const cliEntry = resolveBackfillCliEntry();
  const args = [
    ...process.execArgv,
    cliEntry,
    'once',
    '--batch-size',
    String(batchSize),
    '--max-candidates',
    String(maxCandidates),
    '--save-checkpoint',
    '--json'
  ];
  if (!dryRun) {
    args.push('--write');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    }, timeoutMs);
    timer.unref();

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
      if (timedOut) {
        reject(new Error(`memory backfill timeout after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`memory backfill exit=${code}: ${stderr || stdout || '(empty)'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as MemoryBackfillReport);
      } catch (error) {
        reject(
          new Error(
            `memory backfill produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  });
}

export class MemoryBackfillWorker {
  private readonly enabled: boolean;
  private readonly dryRun: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxCandidates: number;
  private readonly startupDelayMs: number;
  private readonly timeoutMs: number;
  private readonly onAfterRun: (() => void) | undefined;
  private readonly runBackfill: () => Promise<MemoryBackfillReport>;
  private readonly hasPendingArchiveSessions: () => boolean;
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(options: MemoryBackfillWorkerOptions = {}) {
    this.enabled = options.enabled ?? parseBool(process.env.MEMORY_BACKFILL_ENABLED, false);
    this.dryRun = options.dryRun ?? parseBool(process.env.MEMORY_BACKFILL_DRY_RUN, true);
    this.intervalMs = options.intervalMs ?? getIntervalMs();
    this.batchSize =
      options.batchSize ?? parsePositiveInt(process.env.MEMORY_BACKFILL_BATCH_SIZE, 50);
    this.maxCandidates =
      options.maxCandidates ??
      parsePositiveInt(process.env.MEMORY_BACKFILL_MAX_CANDIDATES_PER_RUN, 20);
    this.startupDelayMs = options.startupDelayMs ?? getStartupDelayMs();
    this.timeoutMs = options.timeoutMs ?? getTimeoutMs();
    this.onAfterRun = options.onAfterRun;
    this.runBackfill =
      options.runBackfill ??
      (() => defaultRunBackfill(this.dryRun, this.batchSize, this.maxCandidates, this.timeoutMs));
    this.hasPendingArchiveSessions =
      options.hasPendingArchiveSessions ?? defaultHasPendingArchiveSessions;
  }

  start(): void {
    if (!this.enabled) {
      console.log('[MemoryBackfillWorker] Disabled by MEMORY_BACKFILL_ENABLED.');
      return;
    }

    console.log(
      `[MemoryBackfillWorker] Starting. mode=${this.dryRun ? 'dry-run' : 'write'} intervalMs=${this.intervalMs} startupDelayMs=${this.startupDelayMs}`
    );

    this.startupTimer = setTimeout(() => {
      void this.runOnce('startup');
    }, this.startupDelayMs);
    this.startupTimer.unref();

    this.timer = setInterval(() => {
      void this.runOnce('interval');
    }, this.intervalMs);
    this.timer.unref();
  }

  async runOnce(trigger: 'startup' | 'interval' | 'manual' = 'manual'): Promise<void> {
    if (!this.enabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      if (!this.hasPendingArchiveSessions()) {
        console.log(`[MemoryBackfillWorker] ${trigger} skipped. no new archive sessions.`);
        return;
      }

      const report = await this.runBackfill();
      console.log(
        `[MemoryBackfillWorker] ${trigger} completed. mode=${report.mode} scanned=${report.scannedSessions} candidates=${report.candidates.length} written=${report.written} duplicates=${report.duplicatesSkipped}`
      );
      this.onAfterRun?.();
    } catch (error) {
      recordRuntimeIssue('memory-backfill:worker', error);
      console.warn(`[MemoryBackfillWorker] ${trigger} failed:`, error);
      this.onAfterRun?.();
    } finally {
      this.inFlight = false;
    }
  }

  shutdown(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
