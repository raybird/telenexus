import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';
import {
  describeAiConfigModel,
  readOverrideModel,
  resolveOverridePath,
  type AiConfigModelState,
  type LoadAiConfigOptions
} from './config-loader.js';
import { runProcess } from './process-runner.js';

/**
 * issue 0030：模型設定的共用服務，`/model`、`/models`、`/set_model`、`/reset_model` 與模型面板共用。
 *
 * - 讀取：直接用 config-loader 的合併規則，顯示的模型就是新呼叫實際使用的（SCN-006）。不快取。
 * - 寫入：只寫 data/ai-config.override.yaml（全域、下一次新呼叫生效）。先寫同目錄暫存檔再 rename，
 *   任何一步失敗都保留舊檔（SCN-004）。
 */

export type ModelState = AiConfigModelState;

export function readModelState(options: Pick<LoadAiConfigOptions, 'basePath'> = {}): ModelState {
  return describeAiConfigModel(options);
}

export type ListedModel = { id: string; provider: string };

export type ModelListResult = { ok: true; models: ListedModel[] } | { ok: false; error: string };

export type ListModelsOptions = {
  /** 只列這個 provider（`opencode models <provider>`）。 */
  provider?: string;
  /** 測試注入：回傳 `opencode models` 的 stdout。 */
  run?: (args: string[]) => Promise<string>;
};

const LIST_TIMEOUT_MS = 15_000;

/**
 * 列出 `opencode models` 的模型。opencode 只列有憑證或內建免費的供應商（2026-11-17 查證），
 * 但「列出」不代表認證、額度或模型可呼叫（SCN-003）。
 */
export async function listModels(options: ListModelsOptions = {}): Promise<ModelListResult> {
  const args = options.provider ? ['models', options.provider] : ['models'];
  const run =
    options.run ??
    (async (a: string[]) =>
      (await runProcess('opencode', a, { timeoutMs: LIST_TIMEOUT_MS })).stdout);
  let stdout: string;
  try {
    stdout = await run(args);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const models = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(isModelId)
    .map((id) => ({ id, provider: id.slice(0, id.indexOf('/')) }));
  return { ok: true, models };
}

/** `provider/model`：兩段都非空，不含空白或控制字元。 */
export function isModelId(value: string): boolean {
  return value.length <= 300 && /^[^\s/\p{Cc}]+\/[^\s\p{Cc}]*[^\s/\p{Cc}]$/u.test(value);
}

export type ApplyModelOptions = {
  /** 提供時，ID 必須在清單內（面板用；`/set_model` 沿用原本不檢查清單的行為）。 */
  available?: readonly string[];
  /** 測試注入 rename 失敗。 */
  renameSync?: (from: string, to: string) => void;
};

export type ApplyResult =
  | { ok: true; previous?: string }
  | { ok: false; error: 'invalid-model' | 'not-listed' }
  | { ok: false; error: 'write-failed'; message: string };

export function applyModel(id: string, options: ApplyModelOptions = {}): ApplyResult {
  if (!isModelId(id)) return { ok: false, error: 'invalid-model' };
  if (options.available && !options.available.includes(id)) {
    return { ok: false, error: 'not-listed' };
  }
  const previous = readOverrideModel();
  const overridePath = resolveOverridePath();
  const tmpPath = `${overridePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(path.dirname(overridePath), { recursive: true });
    fs.writeFileSync(tmpPath, yaml.dump({ model: id }), { encoding: 'utf8', flag: 'wx' });
    (options.renameSync ?? fs.renameSync)(tmpPath, overridePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    return {
      ok: false,
      error: 'write-failed',
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return previous ? { ok: true, previous } : { ok: true };
}

export type ResetResult =
  | { ok: true; changed: boolean; previous?: string }
  | { ok: false; error: 'write-failed'; message: string };

export function resetModel(): ResetResult {
  const overridePath = resolveOverridePath();
  if (!fs.existsSync(overridePath)) return { ok: true, changed: false };
  const previous = readOverrideModel();
  try {
    fs.unlinkSync(overridePath);
  } catch (error) {
    return {
      ok: false,
      error: 'write-failed',
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return previous ? { ok: true, changed: true, previous } : { ok: true, changed: true };
}
