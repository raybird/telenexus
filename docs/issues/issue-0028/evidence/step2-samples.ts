// 步驟 2 的樣本：可展開引言的 MarkdownV2 寫法，輸出 JSON 陣列 [{ title, text }] 供 sendMessage 使用。
// 用法：npx tsx docs/issues/issue-0028/evidence/step2-samples.ts > samples.json
//
// 結論用現有轉換器渲染；過程每段也用現有轉換器渲染後在每行前加 `>`，第一行改成 `**>`，
// 最後一行結尾加 `||`。這是設計第 4 點的預定寫法，實測後才定案。
import { renderMarkdownV2 } from '../../../../src/telegram/render/markdown-v2.js';
import { escapeMarkdownV2 } from '../../../../src/telegram/render/escape.js';

type Variant = { blankLine: string };
const WITH_EMPTY_QUOTE_LINE: Variant = { blankLine: '>' };
const WITHOUT_BLANK: Variant = { blankLine: '' };

function quote(process: string[], variant: Variant): string {
  const lines = ['過程'];
  process.forEach((segment, i) => {
    if (i > 0 && variant.blankLine) lines.push('');
    lines.push(...renderMarkdownV2(segment).split('\n'));
  });
  const quoted = lines.map((line) => (line === '' ? variant.blankLine : `>${line}`));
  quoted[0] = `**${quoted[0]}`;
  quoted[quoted.length - 1] = `${quoted[quoted.length - 1]}||`;
  return quoted.filter((line) => line !== '' || variant.blankLine !== '').join('\n');
}

function message(label: string, conclusion: string, process: string[], variant: Variant): string {
  const head = escapeMarkdownV2(`[issue 0028 探測：${label}]`);
  return `${head}\n\n${renderMarkdownV2(conclusion)}\n\n${quote(process, variant)}`;
}

const NARRATION = [
  '數據已到手。接著抓第二個來源。',
  'Binance 仍被擋（HTTP 451），改用 CoinGecko。'
];
const REPORT =
  '**結論**：BTC 與 ETH 偏弱整理，兩源報價一致（價差 0.09%）。\n\n- 支撐 $76,326，阻力 $78,800\n- 資金費率 +0.010%';
const longParagraph = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `第 ${i + 1} 段：市場延續整理，成交量萎縮，留意 $80,000 關卡。`
  ).join('\n\n');

const samples: Array<{ title: string; text: string }> = [
  {
    title: '1 最小（段落之間用空的引言行）',
    text: message('1 最小，段落間空引言行', REPORT, NARRATION, WITH_EMPTY_QUOTE_LINE)
  },
  {
    title: '2 最小（段落之間不空行）',
    text: message('2 最小，段落間不空行', REPORT, NARRATION, WITHOUT_BLANK)
  },
  {
    title: '3 過程裡有清單、粗體、行內程式碼、標題',
    text: message(
      '3 過程含格式',
      REPORT,
      [
        '## 已取得\n\n- **Binance**：`/api/v3/ticker` 回 451\n- CoinGecko：正常（1.2 秒）',
        '改用 `curl -s https://api.example.com/v1?a=1&b=(2)` 補抓。'
      ],
      WITH_EMPTY_QUOTE_LINE
    )
  },
  {
    title: '4 過程以程式碼區塊結尾',
    text: message(
      '4 過程以程式碼區塊結尾',
      REPORT,
      ['先看檔案權限：', '```\nls -la /tmp/opencode\ntotal 28 (x) *y*\n```'],
      WITH_EMPTY_QUOTE_LINE
    )
  },
  {
    title: '5 只有過程的接續訊息（超長時另起的那則）',
    text: quote(NARRATION, WITH_EMPTY_QUOTE_LINE)
  },
  {
    title: '6 排程標頭開頭（SCN-011）',
    text: `${escapeMarkdownV2('🕐 [排程: Crypto Monitor]')}\n\n${renderMarkdownV2(`[Opencode] ${REPORT}`)}\n\n${quote(NARRATION, WITH_EMPTY_QUOTE_LINE)}`
  },
  {
    title: '7 接近 4096 字（結論約 3,000、過程約 1,000）',
    text: message('7 接近上限', longParagraph(84), [longParagraph(27)], WITH_EMPTY_QUOTE_LINE)
  },
  {
    title: '8 刻意寫錯：引言裡的 . 沒有跳脫（預期 400）',
    text: `\\[issue 0028 探測：8 刻意寫錯\\]\n\n結論。\n\n**>過程\n>這一行的句點沒有跳脫.||`
  }
];

console.log(JSON.stringify(samples));
