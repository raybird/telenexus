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

/**
 * 模型健康狀態檔。telenexus 與 agent-runner 共用同一個 data/ volume,
 * 因此必須各自持有狀態檔,否則兩邊會互相覆寫對方的狀態機。
 */
export function resolveModelHealthStatePath(scope = 'main'): string {
  const suffix = scope === 'main' ? '' : `.${scope}`;
  return path.join(resolveDataDir(), `model-health-state${suffix}.json`);
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

// Memoria 已改為遠端 HTTP 服務,其 sessions.db 落在 memoria 容器自己的 volume,
// telenexus 預設無法直接讀。僅在明確設定 MEMORIA_ARCHIVE_DB 或 MEMORIA_HOME(指向可讀路徑)
// 時才回傳實際路徑;否則回傳 data 夾下一個不存在的 sentinel,讓 backfill/health 自動跳過 archive。
export function resolveMemoriaSessionsDbPath(): string {
  const explicit = process.env.MEMORIA_ARCHIVE_DB?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const home = process.env.MEMORIA_HOME?.trim();
  if (home) {
    return path.resolve(home, '.memory', 'sessions.db');
  }
  return path.resolve(resolveDataDir(), 'memoria-archive', '.memory', 'sessions.db');
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
