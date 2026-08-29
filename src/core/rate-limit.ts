/**
 * 上游限流(HTTP 429)的判定 —— 刻意只認結構化的 HTTP 欄位。
 *
 * 為什麼不用寬鬆的 `\b429\b`:
 *   opencode 的 `--print-logs` 會把整包 request body(含 prompt、工具定義與先前的
 *   工具輸出)原樣印進 ERROR 行。本專案的排程任務在跑加密貨幣與股市分析,內容出現
 *   「成交量 429 億美元」這種數字完全正常 —— 寬鬆比對會把一個本來會成功的任務誤砍。
 *
 * 已用 2026-08-29 真實 429 事故的 410KB stderr 驗證命中 `"statusCode":429`,
 * 並確認不會被上述市場數據誤觸。
 *
 * 注意:scripts/probe-models.mjs 另有一份等價的 regex。那支腳本必須能在沒有原始碼、
 * 沒有建置的正式映像裡直接執行,無法 import 這裡的 TypeScript —— 改動兩邊要同步。
 */
export const UPSTREAM_RATE_LIMIT_PATTERN =
  /"status(?:Code)?"\s*:\s*429\b|\bstatus(?:Code)?[=\s]+429\b|RESOURCE_EXHAUSTED/i;

/** 同一段輸出裡出現幾次限流。次數本身就是訊號:健康的模型答一句話不需要重試。 */
export function countUpstreamRateLimitHits(output: string): number {
  return (output.match(new RegExp(UPSTREAM_RATE_LIMIT_PATTERN.source, 'gi')) || []).length;
}
