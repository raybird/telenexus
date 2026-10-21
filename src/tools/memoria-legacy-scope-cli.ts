#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  DEFAULT_LEGACY_SCOPE,
  LegacyScopeMigrationError,
  runLegacyScopeMigration,
  type LegacyScopeReport
} from '../services/memoria-legacy-scope.js';
import { resolveMemoriaSessionsDbPath } from '../utils/paths.js';

dotenv.config({ quiet: true });

function printText(report: LegacyScopeReport): void {
  const lines = [
    `模式：${report.mode === 'write' ? '寫入' : '預覽（加 --write 才會寫入）'}`,
    `資料庫：${report.dbPath}`,
    `舊分區：${report.fromScope}，共 ${report.totals.candidates} 筆`,
    `可遷移：${report.totals.migrate} 筆`
  ];
  for (const [scope, count] of Object.entries(report.byTargetScope)) {
    lines.push(`  → ${scope}：${count} 筆`);
  }
  lines.push(`人工審閱（不遷移）：${report.totals.review} 筆`);
  for (const item of report.review) lines.push(`  - ${item.sessionId}：${item.reason}`);
  if (report.serviceCheck) {
    lines.push(`服務檢查：${report.serviceCheck.endpoint} 連不上，視為 Memoria 已停止`);
  }
  if (report.mode === 'write') {
    lines.push(`已遷移：${report.migrated} 筆`);
    if (report.backupPath) lines.push(`備份：${report.backupPath}`);
    if (report.recordPath) lines.push(`遷移紀錄：${report.recordPath}`);
  }
  console.log(lines.join('\n'));
}

const program = new Command();

program
  .name('memoria-legacy-scope')
  .description('把舊版 project scope 的 Memoria 記憶分類遷移到 user: / scheduler: 分區')
  .option('--db <path>', 'Memoria sessions.db 路徑', resolveMemoriaSessionsDbPath())
  .option('--from-scope <scope>', '要遷移的舊分區', DEFAULT_LEGACY_SCOPE)
  .option('--write', '實際寫入（會先備份整個資料庫）；不加只預覽')
  .option('--json', '輸出 JSON')
  .action(async (options: { db: string; fromScope: string; write?: boolean; json?: boolean }) => {
    try {
      const report = await runLegacyScopeMigration({
        dbPath: path.resolve(options.db),
        fromScope: options.fromScope,
        write: options.write === true
      });
      if (options.json) {
        // 逐筆對照(含重建的 summary)只寫進遷移紀錄,不倒到終端機
        console.log(JSON.stringify({ ...report, plan: undefined }, null, 2));
      } else {
        printText(report);
      }
    } catch (err) {
      const message =
        err instanceof LegacyScopeMigrationError
          ? err.message
          : ((err as Error).stack ?? String(err));
      console.error(`memoria-legacy-scope：${message}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
