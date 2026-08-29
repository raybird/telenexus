export type AgentProvider = 'opencode';

/** 降級原因。使用者中止(EABORTED)不算 —— 那是使用者的意思,不是系統故障。 */
export type AgentFailureKind = 'timeout' | 'rate-limit';

export type AgentFailure = {
  kind: AgentFailureKind;
  message: string;
};

export type AgentStructuredResult = {
  text: string;
  provider: AgentProvider;
  sessionId?: string;
  stats?: unknown;
  raw?: unknown;
  events?: unknown[];
  /**
   * 有值代表「有回傳文字,但那是降級訊息而不是真正的答案」。
   *
   * 逾時與限流都會被 agent 轉成給使用者看的友善句子後正常 resolve,對呼叫端來說
   * 跟成功長得一模一樣 —— 正式環境因此連燒四天:runner audit 全記 ok:true、
   * 成功率顯示 100%、斷路器不跳、Web Console 門檻永遠不觸發。
   * 這個欄位就是讓呼叫端能把「降級」跟「成功」分開的唯一依據。
   */
  failure?: AgentFailure;
};

export type AgentEvent =
  | { type: 'start'; provider: AgentProvider }
  | { type: 'status'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; stats: unknown }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export function buildTextOnlyStructuredResult(
  provider: AgentProvider,
  text: string,
  extra: Omit<AgentStructuredResult, 'provider' | 'text'> = {}
): AgentStructuredResult {
  return {
    provider,
    text,
    ...extra
  };
}
