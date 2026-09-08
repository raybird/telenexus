/**
 * 上游 HTTP 訊號的判定(限流 429 與模型失效 410/not-found) —— 刻意只認結構化的 HTTP 欄位。
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

/**
 * 上游判定「這顆模型不能用」的結構化訊號:已下架(410 / EOL)或根本不存在。
 *
 * 為什麼不認 404:非對話類模型(embedding、圖像、語音)打 chat/completions 也回 404,
 * 那是「用錯端點」不是「模型失效」,混進來會讓告警說錯原因。
 *
 * 2026-09-08 的教訓:`nvidia/openai/gpt-oss-120b` 下架後,opencode 吞掉 AI_APICallError
 * 仍以 exit 0 收場並吐出降級文字,只看 exit code 的判定連續 9 天都說它健康。
 * 結構化訊號是唯一在那段期間仍然誠實的東西 —— 所以它必須比 exit code 先被檢查。
 *
 * 注意:scripts/probe-models.mjs 另有一份等價的 regex(classify() 內),理由同上面的
 * 限流樣式 —— 那支腳本要能在沒有原始碼的正式映像裡直接跑,改動兩邊要同步。
 */
export const UPSTREAM_MODEL_INVALID_PATTERN =
  /"status(?:Code)?"\s*:\s*410\b|\bstatus(?:Code)?[=\s]+410\b|end of life|\bGone\b|ProviderModelNotFoundError|Model not found/i;

/** 輸出裡是否出現模型失效訊號。 */
export function hasUpstreamModelInvalid(output: string): boolean {
  return UPSTREAM_MODEL_INVALID_PATTERN.test(output);
}
