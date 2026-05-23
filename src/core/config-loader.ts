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

/**
 * 讀取 ai-config.yaml 並合併 data/ai-config.override.yaml（若有）。
 * override 只覆寫 model 欄位。
 */
export function loadAiConfig(options: LoadAiConfigOptions = {}): AiConfig {
  const basePath = options.basePath ?? 'ai-config.yaml';
  const allowOverride = options.allowOverride ?? true;

  const base = readYamlSafe(basePath);
  const baseModel = nonEmptyString(base?.model);

  let overrideModel: string | undefined;
  if (allowOverride) {
    const overridePath = resolveOverridePath();
    if (fs.existsSync(overridePath)) {
      const override = readYamlSafe(overridePath);
      overrideModel = nonEmptyString(override?.model);
    }
  }

  const result: AiConfig = { provider: 'opencode' };
  const finalModel = overrideModel ?? baseModel;
  if (finalModel) {
    result.model = finalModel;
  }
  return result;
}
