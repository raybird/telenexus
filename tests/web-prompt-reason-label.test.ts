import test from 'node:test';
import assert from 'node:assert/strict';
import { getWebAppHtml } from '../src/web/server.js';

/**
 * Issue 0012 審查 abd28e3 的 SHOULD FIX:pipeline 新增的 prompt 選擇原因 `new-session`
 * 在 Web Console 備援頁沒有顯示文字,畫面會直接露出原始字串。
 *
 * 從頁面 HTML 抽出瀏覽器實際會執行的 humanizePromptReason() 來跑,
 * 被測的是頁面裡的那段程式,不是另一份複本。
 */
function loadHumanizePromptReason(): (reason: string) => string {
  const html = getWebAppHtml({
    alertErrorThreshold: 1,
    alertRunnerSuccessWarnThreshold: 80
  } as Parameters<typeof getWebAppHtml>[0]);
  const marker = 'function humanizePromptReason(reason) {';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, '頁面裡找不到 humanizePromptReason');
  let depth = 0;
  let end = -1;
  for (let i = start + marker.length - 1; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > start, 'humanizePromptReason 的大括號沒有成對');
  return new Function(`${html.slice(start, end)}\nreturn humanizePromptReason;`)() as (
    reason: string
  ) => string;
}

test('新增的 new-session 有顯示文字', () => {
  assert.equal(loadHumanizePromptReason()('new-session'), '開新 Session');
});

test('pipeline 會產生的每個 prompt 選擇原因都有顯示文字,不會露出原始字串', () => {
  const humanize = loadHumanizePromptReason();
  // 來源:src/core/message-pipeline-chat.ts 與 src/core/message-pipeline.ts 中 promptSelectionReason 的所有值。
  for (const reason of [
    'force-new-session',
    'new-session',
    'periodic-full',
    'compact-followup',
    'minimal-followup',
    'passthrough-command',
    'not-built-yet'
  ]) {
    assert.notEqual(humanize(reason), reason, `${reason} 沒有顯示文字`);
  }
});
