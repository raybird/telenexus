// 步驟 5 的樣本：以新轉換器把下列 Markdown 轉成 MarkdownV2，輸出 JSON 陣列供 sendMessage 使用。
// 用法：npx tsx docs/issues/issue-0027/evidence/step5-samples.ts [--review] > samples.json
import { renderMarkdownV2 } from '../../../../src/telegram/render/markdown-v2.js';

const samples: Array<[string, string]> = [
  ['三層無序清單', '- 第一層 A\n  - 第二層 A-1\n    - 第三層 A-1-a\n      - 第四層\n  - 第二層 A-2\n- 第一層 B'],
  ['編號套無序、編號套編號', '1. 第一點\n   - 子項 甲\n   - 子項 乙\n2. 第二點\n   1. 子編號一\n   2. 子編號二'],
  ['從 3 開始的編號', '3. 第三點\n4. 第四點\n5. 第五點'],
  ['標題六個層級', '# 一級\n\n內文。\n\n## 二級\n\n內文。\n\n### 三級\n\n#### 四級\n\n##### 五級\n\n###### 六級'],
  ['清單裡的程式碼與引言', '1. 執行：\n\n   ```bash\n   npm run build\n   ```\n2. 注意\n\n   > 先確認 .env 已換成另一個 bot\n\n   ### 小標題'],
  ['引言裡的清單與程式碼', '> 引言第一段\n>\n> - 引言清單 甲\n> - 引言清單 乙\n>\n> ```\n> const x = 1; // (a+b)*c\n> ```'],
  ['項目的多個段落', '- 第一段\n\n  第二段\n- 外層\n  - 內層第一段\n\n    內層第二段'],
  ['不認得的節點與 think 標籤', '前 <b>粗</b> 後，圖片 ![圖說](https://example.com/a.png) 照原文。\n\nreasoning done.</think>結論在此'],
  [
    '模擬市場報告',
    '# 市場監控報告\n\n**資料時間：2026-11-13 03:35 UTC**\n\n## 具體觀察\n\n1. **技術面支撐/阻力（日 K）**\n   - BTC：支撐 **$76,326** → $77,250；阻力 **$78,800** → $80,000~81,300。\n   - ETH：支撐 **$2,174** → $2,240；阻力 $2,300~2,360。\n2. **衍生品**：資金費率 +0.010%／-0.002%，多空比 2.54。\n   - 未平倉量 9.7 萬枚（≈$75.5 億）\n\n## 下一步建議\n\n- 關鍵觸發位：跌破 $76,300 視為破位_注意_。\n- 參考 [CoinGecko](https://www.coingecko.com/en) 與 `curl -s https://api.example.com/v1?a=1&b=(2)`'
  ],
  ['分隔線與特殊字元', '特殊字元：_ * [ ] ( ) ~ ` > # + - = | { } . ! \\\n\n---\n\n10-29~30 的 1/4~1/5 量']
];

// review-6436089.md 修正後重送：審查指出的結構，加上改了寫法的標題（樣本 4、9 重送）。
const reviewSamples: Array<[string, string]> = [
  ['標題以斜體結尾（M1）', '# 標題 *強調*\n\n## _全斜體_\n\n# *開頭* 斜體'],
  ['巢狀引言（M2）', '> 外層\n>\n> > 內層\n> >\n> > > 第三層\n\n> - 引言清單\n>\n>   > 清單裡的引言'],
  ['引言裡清單的程式碼（S1）', '> - 項目\n>\n>   ```\n>   code (x) *y*\n>   ```\n\n```\n引言之後的程式碼\n```'],
  ['硬換行續行（N1）', '- 外層\n  - 內層 第一行\\\n    第二行\n  - 內層 B']
];
const useReview = process.argv.includes('--review');
const picked = useReview ? [...reviewSamples, samples[3]!, samples[8]!] : samples;
const label = useReview ? '審查修正樣本' : '完工樣本';

console.log(JSON.stringify(picked.map(([title, md], i) => `\\[issue 0027 ${label} ${i + 1}/${picked.length}：${title.replace(/[-.()]/g, (m) => '\\' + m)}\\]\n\n${renderMarkdownV2(md)}`)));
