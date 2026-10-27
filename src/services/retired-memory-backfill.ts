import { parseBool } from '../utils/env.js';

/**
 * 記憶回填已在 issue 0022 移除。舊 .env 仍開著 MEMORY_BACKFILL_ENABLED 時，啟動印一行，
 * 免得以為回填還在跑。判定沿用移除前 worker 的 parseBool，「1」「yes」也算開著。
 */
export function warnIfMemoryBackfillConfigured(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn
): boolean {
  if (!parseBool(env.MEMORY_BACKFILL_ENABLED, false)) return false;
  warn(
    '[System] 記憶回填已移除（issue 0022），MEMORY_BACKFILL_ENABLED 不再有作用，可以從 .env 刪掉 MEMORY_BACKFILL_* 設定。'
  );
  return true;
}
