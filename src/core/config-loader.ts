import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveProjectDir } from '../utils/paths.js';

export type AiConfig = {
  provider: 'opencode';
  model?: string;
};

type AiConfigYaml = {
  provider?: string;
  model?: string;
};

export type LoadAiConfigOptions = {
  /** ai-config.yaml 路徑（預設：APP_PROJECT_DIR/ai-config.yaml，或 cwd-relative 'ai-config.yaml'） */
  basePath?: string;
  /** 是否套用 data/ai-config.override.yaml（預設：true） */
  allowOverride?: boolean;
};

export function resolveOverridePath(): string {
  return path.resolve(resolveProjectDir(), 'data', 'ai-config.override.yaml');
}

function readYamlSafe(filePath: string): AiConfigYaml | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content) as AiConfigYaml | undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** data/ai-config.override.yaml 的 model；檔案不存在或不合法時為 undefined。 */
export function readOverrideModel(): string | undefined {
  const overridePath = resolveOverridePath();
  if (!fs.existsSync(overridePath)) return undefined;
  return nonEmptyString(readYamlSafe(overridePath)?.model);
}

export type AiConfigModelSource = 'override' | 'base' | 'none';

export type AiConfigModelState = {
  /** 實際呼叫使用的模型；兩個檔都沒有合法值時不存在（交給 opencode 預設）。 */
  model?: string;
  source: AiConfigModelSource;
  baseModel?: string;
  overrideModel?: string;
};

/**
 * 合併規則的唯一實作：override 的 model 是非空字串就用它，否則用 ai-config.yaml 的。
 * 任一檔不存在、YAML 壞掉、model 不是字串或空白，都視為該檔沒有設定。
 * `loadAiConfig()`、`/model` 與模型面板都經過這裡（issue 0030 SCN-006）。
 */
export function describeAiConfigModel(options: LoadAiConfigOptions = {}): AiConfigModelState {
  const basePath = options.basePath ?? 'ai-config.yaml';
  const allowOverride = options.allowOverride ?? true;

  const baseModel = nonEmptyString(readYamlSafe(basePath)?.model);

  const overrideModel = allowOverride ? readOverrideModel() : undefined;

  const state: AiConfigModelState = {
    source: overrideModel ? 'override' : baseModel ? 'base' : 'none'
  };
  const model = overrideModel ?? baseModel;
  if (model) state.model = model;
  if (baseModel) state.baseModel = baseModel;
  if (overrideModel) state.overrideModel = overrideModel;
  return state;
}

/**
 * 讀取 ai-config.yaml 並合併 data/ai-config.override.yaml（若有）。
 * override 只覆寫 model 欄位。
 */
export function loadAiConfig(options: LoadAiConfigOptions = {}): AiConfig {
  const result: AiConfig = { provider: 'opencode' };
  const { model } = describeAiConfigModel(options);
  if (model) {
    result.model = model;
  }
  return result;
}
