import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * docker-compose.yml(開發)與 docker-compose.release.yml(bundle 範本)是兩份獨立維護的檔案,
 * 而 release 檔開頭自己寫著「與開發版的唯一差異是 build: → image:」。沒有東西在守這句話。
 *
 * 實際踩過:v2.25.0 為 agent-runner 加上 mem_limit / pids_limit 時只改了開發版,
 * release bundle 因此交付了一份沒有資源上限的 compose —— 發版流程全綠,產物卻少東西。
 * 這與「兩條交付路徑各自維護一份清單」是同一種病。
 *
 * 這支測試把兩邊的 build: 區塊與 image: 行都正規化成同一個標記後要求逐行相同,
 * 所以任何**其他**差異都會讓 CI 紅燈,不需要有人記得同步。
 */

const ROOT = path.resolve(import.meta.dirname, '../..');

function indentOf(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? '';
}

/** 去掉註解與空行,並把「映像來源」的兩種寫法收斂成同一個標記。 */
function normalize(text: string): string[] {
  const lines = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (/^image:\s*ghcr\.io\//.test(trimmed)) {
      out.push(`${indentOf(line)}<<IMAGE_SOURCE>>`);
      continue;
    }

    if (trimmed === 'build:') {
      const indent = indentOf(line);
      out.push(`${indent}<<IMAGE_SOURCE>>`);
      // build: 底下所有縮排更深的行都屬於它,一併收斂掉。
      while (i + 1 < lines.length && indentOf(lines[i + 1]!).length > indent.length) {
        i += 1;
      }
      continue;
    }

    out.push(line);
  }

  return out;
}

test('release compose differs from dev compose only in build: vs image:', () => {
  const dev = normalize(readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8'));
  const release = normalize(readFileSync(path.join(ROOT, 'docker-compose.release.yml'), 'utf8'));

  // 逐行比對,第一個差異就會被指出來,比整檔字串比對好讀。
  const max = Math.max(dev.length, release.length);
  for (let i = 0; i < max; i += 1) {
    assert.equal(
      release[i],
      dev[i],
      `compose 第 ${i + 1} 行(正規化後)不一致 —— 兩份檔案除了 build:/image: 之外必須完全相同。\n` +
        `  dev:     ${dev[i] ?? '(檔案已結束)'}\n` +
        `  release: ${release[i] ?? '(檔案已結束)'}`
    );
  }
});
