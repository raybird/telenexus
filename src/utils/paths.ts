/**
 * 統一路徑解析工具
 */
import path from 'path';

export function resolveProjectDir(): string {
  return process.env.APP_PROJECT_DIR?.trim() || process.cwd();
}

export function resolveDataDir(): string {
  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir);
  }
  return path.resolve(process.cwd(), 'data');
}

export function resolveDbPath(): string {
  const explicitPath = process.env.DB_PATH?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir, 'moltbot.db');
  }

  return path.resolve(process.cwd(), 'moltbot.db');
}

export function resolveMemoryDbPath(): string {
  return path.resolve(resolveDataDir(), 'memory.db');
}

export function resolveSchedulerHealthPath(): string {
  const explicitPath = process.env.DB_PATH?.trim();
  if (explicitPath) {
    return path.resolve(path.dirname(explicitPath), 'scheduler-health.json');
  }

  const dbDir = process.env.DB_DIR?.trim();
  if (dbDir) {
    return path.resolve(dbDir, 'scheduler-health.json');
  }

  return path.resolve(process.cwd(), 'scheduler-health.json');
}

export function resolveContextDir(): string {
  const projectDir = resolveProjectDir();
  return path.resolve(projectDir, 'workspace', 'context');
}

export function resolveMemoriaSessionsDbPath(): string {
  const projectDir = resolveProjectDir();
  return path.resolve(
    process.env.MEMORIA_HOME || path.join(projectDir, 'workspace', 'Memoria'),
    '.memory',
    'sessions.db'
  );
}

export function resolveMemoryBackfillCheckpointPath(): string {
  const explicitPath = process.env.MEMORY_BACKFILL_CHECKPOINT_FILE?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return path.resolve(resolveDataDir(), 'memory-backfill-checkpoint.json');
}

export function resolveMemoryBackfillReportPath(): string {
  const explicitPath = process.env.MEMORY_BACKFILL_REPORT_FILE?.trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return path.resolve(resolveDataDir(), 'memory-backfill-report.json');
}
