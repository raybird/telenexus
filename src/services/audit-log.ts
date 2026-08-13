/**
 * Audit log 的日輪替與保留期，策略與 event-bus 的 events.jsonl 一致。
 *
 * 先前 runner-audit.log 是 append-only 且沒有任何清理：正式環境實測 6 個月累積
 * 2096 行 / 424KB，且只會單調成長。它就放在 workspace/context/ 底下——也就是 agent
 * 會讀的目錄——所以無上限成長不只是磁碟問題，還是 context 汙染。
 *
 * 抽成獨立模組而非留在 runner.ts，是因為 runner.ts 在 module top-level 就
 * `server.listen()`，測試無法在不啟動 HTTP 服務的情況下 import 它。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RETENTION_DAYS = 7;

function todayStr(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function rotatedNameFor(baseName: string, dateStr: string): string {
  return `${baseName.replace(/\.log$/, '')}-${dateStr}.log`;
}

export type AuditLogWriterOptions = {
  /** 保留天數，預設 7 天（與 events.jsonl 相同）。 */
  retentionDays?: number;
  /** 取得目前時間，測試用來模擬跨日。 */
  now?: () => number;
};

/**
 * 建立一個會自動日輪替 + 過期清除的 audit 寫入器。
 *
 * 路徑每次寫入時才解析（RUNNER_AUDIT_PATH 可在執行期改變），但目錄只在路徑變動時
 * 才 mkdir，不必每寫一行就發一次 syscall。
 */
export function createAuditLogWriter(
  resolvePath: () => string,
  options: AuditLogWriterOptions = {}
): { append: (line: string) => void } {
  const retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;

  let currentDateStr = todayStr(now());
  let ensuredDir: string | null = null;

  function purgeOldFiles(dir: string, baseName: string): void {
    const cutoff = now() - retentionMs;
    const stem = baseName.replace(/\.log$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${stem}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!pattern.test(entry)) continue;
        const fullPath = path.join(dir, entry);
        try {
          if (fs.statSync(fullPath).mtimeMs < cutoff) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // best-effort
        }
      }
    } catch {
      // dir may not exist yet
    }
  }

  function checkAndRotate(auditPath: string): void {
    const today = todayStr(now());
    if (today === currentDateStr) return;

    const dir = path.dirname(auditPath);
    const baseName = path.basename(auditPath);

    try {
      if (fs.existsSync(auditPath)) {
        fs.renameSync(auditPath, path.join(dir, rotatedNameFor(baseName, currentDateStr)));
      }
    } catch {
      // best-effort；與 event-bus 相同，兩個行程搶著輪替是可接受的
    }

    currentDateStr = today;
    purgeOldFiles(dir, baseName);
  }

  return {
    append(line: string): void {
      const auditPath = resolvePath();
      checkAndRotate(auditPath);
      const dir = path.dirname(auditPath);
      if (ensuredDir !== dir) {
        fs.mkdirSync(dir, { recursive: true });
        ensuredDir = dir;
      }
      fs.appendFileSync(auditPath, `${line}\n`, 'utf8');
    }
  };
}
