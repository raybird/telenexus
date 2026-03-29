import { parseBool, parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { runMemoryBackfill } from './memory-backfill.js';

export type MemoryBackfillWorkerOptions = {
  intervalMs?: number;
  enabled?: boolean;
  dryRun?: boolean;
  batchSize?: number;
  maxCandidates?: number;
  startupDelayMs?: number;
  onAfterRun?: () => void;
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

export class MemoryBackfillWorker {
  private readonly enabled: boolean;
  private readonly dryRun: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxCandidates: number;
  private readonly startupDelayMs: number;
  private readonly onAfterRun: (() => void) | undefined;
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
    this.onAfterRun = options.onAfterRun;
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
      const report = runMemoryBackfill({
        batchSize: this.batchSize,
        maxCandidates: this.maxCandidates,
        fromCheckpoint: true,
        saveCheckpoint: true,
        write: !this.dryRun
      });
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
