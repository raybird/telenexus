import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeAgent } from '../src/core/opencode.js';

/**
 * 放一支假的 `opencode` 到 PATH 最前面。
 *
 * 它刻意只有在收到 `--print-logs` 時才把 429 吐到 stderr —— 真正的 opencode 就是這樣:
 * 沒有這個旗標,上游錯誤只會進它自己的 log 檔,呼叫端什麼都看不到。所以這支腳本同時
 * 驗證了「旗標有傳下去」與「fail-fast 有生效」。
 *
 * 吐完 429 之後睡很久:若 fail-fast 沒作用,測試就會撞到 timeoutMs 而失敗(而不是靜靜通過)。
 */
function installFakeOpencode(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-fake-opencode-'));
  const binary = path.join(dir, 'opencode');
  fs.writeFileSync(
    binary,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--print-logs" ]; then
    echo 'ERROR service=llm error={"error":{"name":"AI_APICallError","statusCode":429,"isRetryable":true}} stream error' >&2
  fi
done
sleep 60
`,
    { mode: 0o755 }
  );

  const previousPath = process.env.PATH;
  const previousTimeout = process.env.OPENCODE_TASK_TIMEOUT_MS;
  process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
  // 保險絲調短：fail-fast 若失效，測試要在幾秒內失敗，而不是掛滿 30 分鐘預設值。
  process.env.OPENCODE_TASK_TIMEOUT_MS = '8000';

  return {
    dir,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousTimeout === undefined) delete process.env.OPENCODE_TASK_TIMEOUT_MS;
      else process.env.OPENCODE_TASK_TIMEOUT_MS = previousTimeout;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('summarize 遇到上游 429 會快速中止，不會掛到逾時', async () => {
  const fake = installFakeOpencode();
  try {
    const startedAt = Date.now();
    const result = await new OpencodeAgent().summarize('原始內容需要被摘要');
    const elapsedMs = Date.now() - startedAt;

    // fail-fast 實測約 1 秒；給到 5 秒仍遠低於 8 秒的保險絲。
    assert.ok(
      elapsedMs < 5000,
      `summarize 應在 429 出現時立即中止，實際耗時 ${elapsedMs}ms —— ` +
        'runProcess 少了 timeoutMs 或 abortOnStderr 就會退化成無限期等待'
    );
    // summarize 的降級行為：中止後回退成截斷的原文，而不是拋例外。
    assert.ok(result.startsWith('原始內容需要被摘要'));
  } finally {
    fake.restore();
  }
});
