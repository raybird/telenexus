/**
 * 統一路徑解析工具
 */
import path from 'path';

export function resolveProjectDir(): string {
  return process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
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
