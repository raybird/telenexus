import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLogWriter } from '../src/services/audit-log.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-audit-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('同一天內持續 append 到同一個檔案', () => {
  withTempDir((dir) => {
    const auditPath = path.join(dir, 'runner-audit.log');
    let now = Date.parse('2026-08-13T02:00:00.000Z');
    const writer = createAuditLogWriter(() => auditPath, { now: () => now });

    writer.append('{"a":1}');
    now += 60_000;
    writer.append('{"a":2}');

    assert.equal(fs.readFileSync(auditPath, 'utf8'), '{"a":1}\n{"a":2}\n');
    assert.deepEqual(fs.readdirSync(dir), ['runner-audit.log']);
  });
});

test('跨日時把舊內容輪替成帶日期的檔名，主檔重新開始', () => {
  withTempDir((dir) => {
    const auditPath = path.join(dir, 'runner-audit.log');
    let now = Date.parse('2026-08-13T02:00:00.000Z');
    const writer = createAuditLogWriter(() => auditPath, { now: () => now });

    writer.append('{"day":"13"}');
    now += DAY_MS; // 跨到 08-14
    writer.append('{"day":"14"}');

    assert.equal(fs.readFileSync(auditPath, 'utf8'), '{"day":"14"}\n');
    assert.equal(
      fs.readFileSync(path.join(dir, 'runner-audit-2026-08-13.log'), 'utf8'),
      '{"day":"13"}\n'
    );
  });
});

test('輪替時清掉超過保留期的舊檔，保留期內的留著', () => {
  withTempDir((dir) => {
    const auditPath = path.join(dir, 'runner-audit.log');
    let now = Date.parse('2026-08-13T02:00:00.000Z');

    const stale = path.join(dir, 'runner-audit-2026-08-01.log');
    const fresh = path.join(dir, 'runner-audit-2026-08-11.log');
    fs.writeFileSync(stale, 'old\n');
    fs.writeFileSync(fresh, 'recent\n');
    fs.utimesSync(stale, new Date(now - 12 * DAY_MS), new Date(now - 12 * DAY_MS));
    fs.utimesSync(fresh, new Date(now - 2 * DAY_MS), new Date(now - 2 * DAY_MS));

    const writer = createAuditLogWriter(() => auditPath, { now: () => now });
    writer.append('{"seed":true}');
    now += DAY_MS; // 觸發輪替 + 清除
    writer.append('{"after":true}');

    assert.equal(fs.existsSync(stale), false, '超過 7 天的應被清掉');
    assert.equal(fs.existsSync(fresh), true, '保留期內的應留著');
  });
});

test('清除只針對自己的輪替檔，不動同目錄的其他檔案', () => {
  withTempDir((dir) => {
    const auditPath = path.join(dir, 'runner-audit.log');
    let now = Date.parse('2026-08-13T02:00:00.000Z');

    // workspace/context/ 底下還住著 events 輪替檔與 markdown 快照，都不該被碰到
    const others = ['events-2026-08-01.jsonl', 'runtime-status.md', 'other-audit-2026-08-01.log'];
    for (const name of others) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x\n');
      fs.utimesSync(p, new Date(now - 30 * DAY_MS), new Date(now - 30 * DAY_MS));
    }

    const writer = createAuditLogWriter(() => auditPath, { now: () => now });
    writer.append('{"seed":true}');
    now += DAY_MS;
    writer.append('{"after":true}');

    for (const name of others) {
      assert.equal(fs.existsSync(path.join(dir, name)), true, `${name} 不該被清除`);
    }
  });
});

test('目錄不存在時會自動建立', () => {
  withTempDir((dir) => {
    const auditPath = path.join(dir, 'nested', 'deeper', 'runner-audit.log');
    const writer = createAuditLogWriter(() => auditPath);
    writer.append('{"ok":true}');
    assert.equal(fs.readFileSync(auditPath, 'utf8'), '{"ok":true}\n');
  });
});

test('保留天數可調整', () => {
  withTempDir((dir) => {
    const auditPath = path.join(dir, 'runner-audit.log');
    let now = Date.parse('2026-08-13T02:00:00.000Z');

    const target = path.join(dir, 'runner-audit-2026-08-10.log');
    fs.writeFileSync(target, 'x\n');
    fs.utimesSync(target, new Date(now - 3 * DAY_MS), new Date(now - 3 * DAY_MS));

    const writer = createAuditLogWriter(() => auditPath, { now: () => now, retentionDays: 1 });
    writer.append('{"seed":true}');
    now += DAY_MS;
    writer.append('{"after":true}');

    assert.equal(fs.existsSync(target), false, 'retentionDays=1 時 3 天前的檔應被清掉');
  });
});
