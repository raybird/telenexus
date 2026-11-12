import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// issue 0025 SCN-010：本機建置只帶 workspace/ 的骨架檔，和從乾淨 checkout 建置的 CI 一致。
// workspace/ 是 bind mount 的執行期狀態（同步出來的技能、Memoria、projects…），2026-11-12 量到 6,587 個檔案。
const lines = fs
  .readFileSync(new URL('../../.dockerignore', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

test('SCN-010 .dockerignore 排除整個 workspace/，只放行 git 追蹤的骨架檔', () => {
  const exclude = lines.indexOf('workspace/**');
  assert.ok(exclude >= 0, '要有 workspace/** 排除規則');
  const allowed = lines.filter((line) => line.startsWith('!workspace/'));
  // 放行規則要排在排除規則之後才會生效。
  for (const line of allowed) assert.ok(lines.indexOf(line) > exclude, `${line} 要排在 workspace/** 之後`);
  const tracked = execFileSync('git', ['ls-files', 'workspace'], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(allowed.map((line) => line.slice(1)).sort(), tracked, '放行的檔案要正好是 git 追蹤的 workspace 骨架');
});
