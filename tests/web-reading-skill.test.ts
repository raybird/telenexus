import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// issue 0024 SCN-001～004 的文字層檢查。模型是否照著走由步驟 6 的實際 OpenCode 工具路徑驗證；
// 這裡只確認出貨的指引寫了三層的順序與退回條件。
const skill = readFileSync(new URL('../skills/web-reading/SKILL.md', import.meta.url), 'utf8');
const legacy = JSON.parse(readFileSync(new URL('../scripts/retired-web-reading.json', import.meta.url), 'utf8')) as {
  files: Record<string, string>;
};

test('SCN-001～003 指引的順序是 webfetch → telenexus-moli-fetch → 本工作瀏覽器', () => {
  // description 也會提到這些名稱，順序只看 frontmatter 之後的正文。
  const body = skill.slice(skill.indexOf('\n---\n', 4) + 5);
  const webfetch = body.indexOf('`webfetch`');
  const moli = body.indexOf('telenexus-moli-fetch');
  const chrome = body.indexOf('telenexus_browser_navigate');
  assert.ok(webfetch >= 0 && moli >= 0 && chrome >= 0, '三層都要出現');
  assert.ok(webfetch < moli && moli < chrome, `順序不對：webfetch=${webfetch} moli=${moli} chrome=${chrome}`);
  assert.match(skill, /結束碼非 0/);
  assert.match(skill, /只有殼層/);
});

test('SCN-004 三層都讀不到時明確說明讀取失敗', () => {
  assert.match(skill, /明確說明讀取失敗/);
});

test('SCN-008 新版指引與已出貨舊版不同，升級才會發生', () => {
  const hash = createHash('sha256').update(skill).digest('hex');
  assert.notEqual(hash, legacy.files['SKILL.md']);
  assert.match(skill, /^---\nname: web-reading\n/);
});
