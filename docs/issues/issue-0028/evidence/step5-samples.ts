// 步驟 5 的樣本：以實際的 buildFoldedMessages() 與 TelegramConnector 的渲染產生訊息，
// 輸出 JSON 陣列 [{ title, text, plain? }] 供 sendMessage 使用。內容是合成的，不取正式資料。
// 用法：npx tsx docs/issues/issue-0028/evidence/step5-samples.ts > samples.json
import { TelegramConnector } from '../../../../src/connectors/telegram.js';
import { buildFoldedMessages } from '../../../../src/telegram/render/folded-reply.js';
import type { FoldedReply } from '../../../../src/types/index.js';

const connector = Object.create(TelegramConnector.prototype) as {
  renderForMarkdownV2(text: string): string;
};
const render = (markdown: string) => connector.renderForMarkdownV2(markdown);

const report = [
  '# 市場監控報告',
  '',
  '**資料時間：2026-11-16 09:00 UTC**',
  '',
  '1. **技術面**',
  '   - BTC：支撐 **$76,326**，阻力 $78,800',
  '   - ETH：支撐 $2,174',
  '2. **衍生品**：資金費率 +0.010%',
  '',
  '| 幣種 | 價格 | 24h |',
  '|---|---|---|',
  '| BTC | 77,250 | -1.2% |',
  '| ETH | 2,240 | -0.8% |'
].join('\n');
const longReport = Array.from(
  { length: 110 },
  (_, i) => `第 ${i + 1} 段：市場延續整理，成交量萎縮，留意 $80,000 關卡（樣本 ${i + 1}）。`
).join('\n\n');
const longProcess = Array.from(
  { length: 40 },
  (_, i) => `步驟 ${i + 1}：抓取第 ${i + 1} 個來源，比對報價差 0.0${i % 10}%。`
).join('\n\n');

const replies: Array<[string, FoldedReply]> = [
  [
    '一般長度（聊天）',
    {
      conclusion: '[Opencode] **結論**：BTC 與 ETH 偏弱整理，兩源報價一致（價差 0.09%）。',
      process: ['數據已到手。接著抓第二個來源。', 'Binance 仍被擋（HTTP 451），改用 CoinGecko。']
    }
  ],
  [
    '過程含清單與程式碼（聊天）',
    {
      conclusion: `[Opencode] ${report}`,
      process: [
        '## 已取得\n\n- **Binance**：`/api/v3/ticker` 回 451\n- CoinGecko：正常（1.2 秒）',
        '補抓指令：\n\n```bash\ncurl -s "https://api.example.com/v1?a=1&b=(2)"\n```'
      ]
    }
  ],
  [
    '排程結果（有過程）',
    {
      header: '🕐 [排程: Crypto Monitor]',
      conclusion: `[Opencode] ${report}`,
      process: ['先讀取上次的報告。', '兩個來源都取得，開始彙整。']
    }
  ],
  [
    '超長（結論切段、過程另起）',
    {
      header: '🕐 [排程: Crypto Monitor]',
      conclusion: `[Opencode] ${longReport}`,
      process: [longProcess, '彙整完成。']
    }
  ],
  [
    '排程結果（沒有過程）',
    { header: '🕐 [排程: 每日摘要]', conclusion: `[Opencode] ${report}`, process: [] }
  ]
];

const out = replies.flatMap(([title, reply], r) =>
  buildFoldedMessages(reply, render).map((message, i, all) => ({
    title: `${r + 1}. ${title}（${i + 1}/${all.length}）`,
    text: message.markdownV2,
    ...(message.plain !== undefined ? { plain: message.plain } : {})
  }))
);
console.log(JSON.stringify(out));
