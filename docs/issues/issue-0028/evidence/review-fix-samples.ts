// 審查修正後的探測樣本：過程裡的 Markdown 引言、程式碼區塊裡以 > 開頭的行。
// 以實際的 buildFoldedMessages() 與 TelegramConnector 的渲染產生，內容是合成的。
// 用法：npx tsx docs/issues/issue-0028/evidence/review-fix-samples.ts > samples.json
import { TelegramConnector } from '../../../../src/connectors/telegram.js';
import { buildFoldedMessages } from '../../../../src/telegram/render/folded-reply.js';
import type { FoldedReply } from '../../../../src/types/index.js';

const connector = Object.create(TelegramConnector.prototype) as {
  renderForMarkdownV2(text: string): string;
};
const render = (markdown: string) => connector.renderForMarkdownV2(markdown);

const replies: Array<[string, FoldedReply]> = [
  [
    '過程裡有 Markdown 引言',
    {
      conclusion: '[Opencode] [審查修正探測 1/2] 結論：兩源一致。',
      process: ['讀到來源的說明：\n\n> 注意：報價每 5 分鐘更新一次。', '改用 CoinGecko。']
    }
  ],
  [
    '程式碼區塊裡有以 > 開頭的行',
    {
      conclusion: '[Opencode] [審查修正探測 2/2] 結論：指令可用。',
      process: ['執行結果：\n\n```\n$ node -e "console.log(1)"\n> 1\n```']
    }
  ]
];

console.log(
  JSON.stringify(
    replies.flatMap(([title, reply]) =>
      buildFoldedMessages(reply, render).map((message) => ({ title, text: message.markdownV2 }))
    )
  )
);
