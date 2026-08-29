import type { AgentFailureKind, AgentStructuredResult } from './agent-result.js';

export type RunOutcome = {
  ok: boolean;
  failureKind?: AgentFailureKind;
  error?: string;
};

/**
 * 從 agent 結果推導「這次有沒有真的產出答案」。
 *
 * 逾時與限流會被 agent 轉成友善句子後正常 resolve,對呼叫端來說跟成功長得一模一樣。
 * 2026-08-25 起正式環境每發排程都燒滿 30 分鐘才失敗,runner audit 卻全記 ok:true、
 * 成功率顯示 100.0%、Web Console 的 80% 門檻永遠不觸發 —— 連燒四天沒人發現。
 *
 * 只用於 audit 與統計,不改 HTTP 回應的 ok:傳輸層確實成功了,而且刻意不讓它觸發
 * DynamicAIAgent 的斷路器 —— 斷路器的語意是「runner 壞了就改跑本地」,但上游 429
 * 對本地一樣會發生,切過去只是原地再撞一次牆還多耗一份資源。
 */
export function deriveRunOutcome(structured?: AgentStructuredResult): RunOutcome {
  const failure = structured?.failure;
  if (!failure) {
    return { ok: true };
  }
  return { ok: false, failureKind: failure.kind, error: failure.message };
}
