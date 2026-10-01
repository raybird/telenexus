/**
 * 上游 HTTP 訊號的判定(限流 429 與模型失效 410/not-found) —— 有結構化的 HTTP 欄位時只認它。
 *
 * 為什麼不用寬鬆的 `\b429\b`:
 *   舊版 opencode(實測 1.15.10)的 `--print-logs` 會把整包 request body(含 prompt、工具定義與先前的
 *   工具輸出)原樣印進 ERROR 行。本專案的排程任務在跑加密貨幣與股市分析,內容出現
 *   「成交量 429 億美元」這種數字完全正常 —— 寬鬆比對會把一個本來會成功的任務誤砍。
 *
 * 已用 2026-08-29 真實 429 事故的 410KB stderr 驗證命中 `"statusCode":429`,
 * 並確認不會被上述市場數據誤觸。
 *
 * opencode 1.18(實測 1.18.0、1.18.17、1.18.34)的 `--print-logs` 是 logfmt,stderr 裡沒有狀態碼,
 * 也不回吐 request body。
 * 重試期間 stdout 沒有任何事件,唯一即時可見的訊號是這一行:
 *   level=ERROR message="stream error" … small=false … error.error="AI_APICallError: <上游訊息>"
 * 所以最後一個分支比對的是文字,但範圍鎖在三個條件內:
 *   - `stream error` 行的 `error.error` 欄位。這個欄位只有上游的錯誤訊息,沒有 request body,
 *     上面說的市場數據誤觸來源不在這裡。
 *   - `small=false`(主代理)。標題代理用另一顆小模型,它被限流不代表主模型不能用。
 *   - 訊息含限流字樣。`Too Many Requests` 是以真實 nvidia 429 的 body 重現的(body 沒有訊息時
 *     opencode 退回 HTTP 狀態文字);`Rate limit exceeded` 是免費層 2026-08-16 事故紀錄的措辭;
 *     `quota` 與 `429` 是其他常見寫法,沒有實際樣本。`rate limit` 也認 `RateLimitError`、
 *     `rate_limit_exceeded` 這類寫法,但排除 `rate limiter`(那是元件名稱,不是被限流)。
 * 上游換成清單以外的措辭時這個分支不會命中,回合會退避到逾時後記為逾時失敗。
 * 樣本與比對過程見 docs/issues/issue-0008/evidence/step1-compat-probe.md。
 *
 * 注意:scripts/probe-models.mjs 另有一份等價的 regex。那支腳本必須能在沒有原始碼、
 * 沒有建置的正式映像裡直接執行,無法 import 這裡的 TypeScript —— 改動兩邊要同步。
 */
export const UPSTREAM_RATE_LIMIT_PATTERN =
  /"status(?:Code)?"\s*:\s*429\b|\bstatus(?:Code)?[=\s]+429\b|RESOURCE_EXHAUSTED|message="stream error"[^\n]*\bsmall=false\b[^\n]*\berror\.error="AI_APICallError: [^"\n]*(?:Too Many Requests|rate[ _-]?limit(?!ers?\b)|quota|\b429\b)/i;

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
 * 為什麼不認裸的 `Gone`:理由同上面限流樣式不認裸 `429` —— `--print-logs` 會回吐整包
 * request body,一句「the opportunity is gone」或「動能已經 gone」就會被判成模型下架。
 * `gone` 是英文常用字,誤觸機率比 429 更高。要判 410 就去比對結構化的 statusCode。
 * (2026-09-08 v2.27.2 初版帶著這個過寬的分支發佈,由 Wukong 專案的交接回饋抓出。)
 *
 * 2026-09-08 的教訓:`nvidia/openai/gpt-oss-120b` 下架後,opencode 吞掉 AI_APICallError
 * 仍以 exit 0 收場並吐出降級文字,只看 exit code 的判定連續 9 天都說它健康。
 * 結構化訊號是唯一在那段期間仍然誠實的東西 —— 所以它必須比 exit code 先被檢查。
 *
 * 注意:scripts/probe-models.mjs 另有一份等價的 regex(classify() 內),理由同上面的
 * 限流樣式 —— 那支腳本要能在沒有原始碼的正式映像裡直接跑,改動兩邊要同步。
 */
export const UPSTREAM_MODEL_INVALID_PATTERN =
  /"status(?:Code)?"\s*:\s*410\b|\bstatus(?:Code)?[=\s]+410\b|end of life|ProviderModelNotFoundError|Model not found/i;

/** 輸出裡是否出現模型失效訊號。 */
export function hasUpstreamModelInvalid(output: string): boolean {
  return UPSTREAM_MODEL_INVALID_PATTERN.test(output);
}

/** opencode 的 `error` 事件帶出的上游錯誤。`statusCode` 不一定有(例如 `UnknownError`)。 */
export type UpstreamError = {
  statusCode?: number;
  name?: string;
  message: string;
};

export type UpstreamErrorClass = 'rate-limited' | 'model-invalid' | 'client-outdated' | 'other';

/**
 * 狀態碼到分類的唯一對應。分類只決定說明文字與告警措辭 ——「這個回合失敗了」不看分類,
 * 有 `error` 事件就是失敗。2026-09-08 的 410 與 2026-09-17 的 426 都是因為判定逐一列舉
 * 狀態碼而漏掉的,所以沒列在這裡的狀態碼一律落到 `other`,而不是被當成成功。
 *
 * 404 歸 `other` 的理由同上面的失效樣式:它也可能是「用錯端點」,說成模型下架會講錯原因。
 */
export function classifyUpstreamStatus(statusCode: number | undefined): UpstreamErrorClass {
  switch (statusCode) {
    case 429:
      return 'rate-limited';
    case 410:
      return 'model-invalid';
    case 426:
      return 'client-outdated';
    default:
      return 'other';
  }
}

const UPSTREAM_MESSAGE_SNIPPET_LENGTH = 200;

/** 給使用者看的上游錯誤說明。串流與非串流共用,兩條路徑的訊息才會一致。 */
export function describeUpstreamError(error: UpstreamError): string {
  const status = error.statusCode === undefined ? '' : ` (HTTP ${error.statusCode})`;
  const detail = error.message.trim().slice(0, UPSTREAM_MESSAGE_SNIPPET_LENGTH);
  const suffix = detail ? `\n上游訊息：${detail}` : '';

  switch (classifyUpstreamStatus(error.statusCode)) {
    case 'rate-limited':
      return `⏳ 上游配額已達上限${status}，請稍後再試或錯開排程時間。${suffix}`;
    case 'model-invalid':
      return `⚠️ 上游回報模型已失效${status}，請用 /set_model 換一個模型。${suffix}`;
    case 'client-outdated':
      return `⚠️ 上游拒絕了這次請求${status}：opencode 版本過舊，需要升級 opencode 才能繼續使用這個模型。${suffix}`;
    case 'other':
      return `⚠️ 上游回了錯誤${status}，這次請求沒有完成。${suffix}`;
  }
}
