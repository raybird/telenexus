import { parsePositiveInt } from '../utils/env.js';

/**
 * Opencode CLI 子程序執行 timeout(含串流模式)。
 * 同時控制 runProcess 的 timeoutMs 與 CliAgentBase 的 streamTimeoutMs。
 */
export function getOpencodeTaskTimeoutMs(): number {
  return parsePositiveInt(process.env.OPENCODE_TASK_TIMEOUT_MS, 1800000);
}

/**
 * Runner HTTP 請求 timeout,集中文件化,實際讀取在 main.ts getRunnerRequestTimeoutMs()。
 * 對應 env: RUNNER_REQUEST_TIMEOUT_MS(預設 650000ms)
 */
export const RUNNER_REQUEST_TIMEOUT_MS_DEFAULT = 650000;
