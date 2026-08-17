import type { AIAgentOptions } from './agent.js';

/**
 * runner HTTP 請求裡與 agent 選項有關的欄位(結構型別,避免測試得 import 有 side effect 的 runner.ts)。
 */
export type RunnerOptionSource = {
  model?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
  autoRecoveryNotice?: boolean;
  lane?: 'interactive' | 'scheduled';
};

/**
 * 把 runner 請求攤成 AIAgentOptions。
 *
 * ⚠️ `lane` → `fromScheduler` 這一條是關鍵:runner 一直收得到 lane,卻從來沒有往下傳給 agent,
 * CLI 端因此無從得知這輪是不是排程。排程結束後的 agent-browser session 清理靠的就是這個旗標 ——
 * 少了它,走 runner 的排程(`CHAT_USE_RUNNER_PERCENT > 0`)永遠不會被清理,而且是靜默的。
 *
 * 回傳 undefined 而非空物件,維持既有呼叫端「沒有選項就不傳」的語意。
 */
export function buildAgentOptions(
  source: RunnerOptionSource,
  configModel?: string
): AIAgentOptions | undefined {
  const model = source.model || configModel;
  const options: AIAgentOptions = {
    ...(model ? { model } : {}),
    ...(source.isPassthroughCommand ? { isPassthroughCommand: true } : {}),
    ...(source.forceNewSession ? { forceNewSession: true } : {}),
    ...(source.autoRecoveryNotice ? { autoRecoveryNotice: true } : {}),
    ...(source.lane === 'scheduled' ? { fromScheduler: true } : {})
  };
  return Object.keys(options).length > 0 ? options : undefined;
}
