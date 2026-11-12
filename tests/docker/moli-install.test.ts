import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// issue 0024 SCN-007：釘版值來自 2026-11-12 步驟 1 的實測（docs/issues/issue-0024/evidence/step1-moli-probe.md），
// 雜湊與 GitHub release asset 公布的 digest 相同。
const MOLI_VERSION = '1.1.23';
const MOLI_SHA256 = 'df360c04e567ce2e56a8391a03dc677d794465848b5821f944d2de10f3f1f430';
const MOLI_TARBALL_URL = `https://github.com/lexmount/moli/releases/download/v${MOLI_VERSION}/moli-x86_64-unknown-linux-gnu.tar.gz`;

const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const base = dockerfile.split('FROM node:22-slim AS base')[1]?.split('FROM base AS dev')[0] ?? '';

/** 把 base stage 拆成指令，接續行（行尾 `\`）併成一條。 */
function instructions(stage: string): string[] {
  return stage
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

test('SCN-007 base stage 以固定版本的 release tarball 安裝 Moli，並在同一條 RUN 驗 sha256', () => {
  const runs = instructions(base).filter((line) => line.startsWith('RUN ') && line.includes('lexmount/moli'));
  assert.equal(runs.length, 1, '安裝 Moli 的 RUN 只能有一條');
  const run = runs[0] ?? '';
  assert.ok(run.includes(MOLI_TARBALL_URL), '下載固定版本的 x86_64 linux tarball');
  assert.ok(run.includes(MOLI_SHA256), '寫死 tarball 的 sha256');
  assert.match(run, /sha256sum -c/);
  assert.ok(
    run.indexOf('sha256sum -c') < run.indexOf('tar '),
    '先驗雜湊再解開 tarball'
  );
});

test('SCN-007 Moli 不用 latest 或 curl | sh 安裝', () => {
  const moliLines = instructions(dockerfile).filter((line) => /moli/i.test(line));
  for (const line of moliLines) {
    assert.doesNotMatch(line, /releases\/latest/);
    assert.doesNotMatch(line, /moli-installer/);
    assert.doesNotMatch(line, /\|\s*(ba)?sh\b/);
  }
});

test('SCN-006 wrapper 安裝成 /usr/local/bin/telenexus-moli-fetch，而且可執行', () => {
  const copies = instructions(base).filter((line) => line.startsWith('COPY ') && line.includes('moli-fetch'));
  assert.equal(copies.length, 1, '只 COPY 一次');
  assert.match(copies[0] ?? '', /^COPY (--chmod=755 )?scripts\/moli-fetch\.sh \/usr\/local\/bin\/telenexus-moli-fetch$/);
  // COPY 沒帶 --chmod 時保留檔案權限，所以 repo 裡的檔案本身要可執行。
  assert.ok((fs.statSync(new URL('../../scripts/moli-fetch.sh', import.meta.url)).mode & 0o111) !== 0, 'scripts/moli-fetch.sh 要可執行');
});
