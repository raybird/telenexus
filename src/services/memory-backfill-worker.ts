import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { parseBool, parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import type { MemoryBackfillReport } from './memory-backfill.js';
import { assessBackfillSource, type BackfillSourceAssessment } from './memory-health.js';

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
  assessArchiveSource?: () => BackfillSourceAssessment;
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
  private readonly assessArchiveSource: () => BackfillSourceAssessment;
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
    this.assessArchiveSource = options.assessArchiveSource ?? assessBackfillSource;
  }

  start(): void {
    if (!this.enabled) {
      console.log('[MemoryBackfillWorker] Disabled by MEMORY_BACKFILL_ENABLED.');
      return;
    }

    console.log(
      `[MemoryBackfillWorker] Starting. mode=${this.dryRun ? 'dry-run' : 'write'} source=${this.assessArchiveSource().source} intervalMs=${this.intervalMs} startupDelayMs=${this.startupDelayMs}`
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
      const { state, detail } = this.assessArchiveSource();
      if (state === 'error') {
        // 和原本讀取封存時 throw 一樣，交給下方的 catch 記 runtime issue
        throw new Error(detail);
      }
      if (state === 'up-to-date') {
        console.log(`[MemoryBackfillWorker] ${trigger} skipped. no new archive sessions.`);
        return;
      }
      if (state !== 'pending') {
        console.log(`[MemoryBackfillWorker] ${trigger} skipped. ${state}: ${detail}`);
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
