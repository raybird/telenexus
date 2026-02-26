import fs from 'fs';
import http from 'http';
import https from 'https';
import yaml from 'js-yaml';
import { GeminiAgent } from './gemini.js';
import { OpencodeAgent } from './opencode.js';

export interface AIAgentOptions {
  model?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
}

type RunnerTask = 'chat' | 'summarize';

interface RunnerRequest {
  task: RunnerTask;
  input: string;
  provider: string;
  model?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
}

interface RunnerResponse {
  ok: boolean;
  output?: string;
  provider?: string;
  requestId?: string;
  durationMs?: number;
  error?: string;
}

export interface DynamicAgentOptions {
  runnerEndpoint?: string;
  preferRunner?: boolean;
  fallbackToLocal?: boolean;
  runnerTimeoutMs?: number;
  runnerToken?: string;
  runnerFailureThreshold?: number;
  runnerCooldownMs?: number;
}

export interface AIAgent {
  chat(prompt: string, options?: AIAgentOptions): Promise<string>;
  summarize(text: string, options?: AIAgentOptions): Promise<string>;
}

interface AIConfig {
  provider?: string;
  model?: string | undefined;
}

/**
 * DynamicAIAgent 動態代理人
 * 每次呼叫時重新讀取 ai-config.yaml 來決定使用哪個 provider
 */
export class DynamicAIAgent implements AIAgent {
  private geminiAgent: GeminiAgent;
  private opencodeAgent: OpencodeAgent;
  private configPath: string;
  private runnerEndpoint: string | null;
  private preferRunner: boolean;
  private fallbackToLocal: boolean;
  private runnerTimeoutMs: number;
  private runnerToken: string | null;
  private runnerFailureThreshold: number;
  private runnerCooldownMs: number;
  private consecutiveRunnerFailures: number;
  private runnerOpenUntil: number;

  constructor(configPath = 'ai-config.yaml', options: DynamicAgentOptions = {}) {
    this.configPath = configPath;
    this.geminiAgent = new GeminiAgent();
    this.opencodeAgent = new OpencodeAgent();
    this.runnerEndpoint = options.runnerEndpoint?.trim() || null;
    this.preferRunner = options.preferRunner ?? false;
    this.fallbackToLocal = options.fallbackToLocal ?? true;
    this.runnerTimeoutMs = options.runnerTimeoutMs ?? 650000;
    this.runnerToken = options.runnerToken?.trim() || null;
    this.runnerFailureThreshold =
      options.runnerFailureThreshold && options.runnerFailureThreshold > 0
        ? options.runnerFailureThreshold
        : 3;
    this.runnerCooldownMs =
      options.runnerCooldownMs && options.runnerCooldownMs >= 1000
        ? options.runnerCooldownMs
        : 60000;
    this.consecutiveRunnerFailures = 0;
    this.runnerOpenUntil = 0;
  }

  private isRunnerCircuitOpen(): boolean {
    return this.runnerOpenUntil > Date.now();
  }

  private markRunnerFailure(errorMessage: string): void {
    this.consecutiveRunnerFailures += 1;
    if (this.consecutiveRunnerFailures >= this.runnerFailureThreshold) {
      this.runnerOpenUntil = Date.now() + this.runnerCooldownMs;
      console.warn(
        `[DynamicAgent] Runner circuit opened for ${this.runnerCooldownMs}ms after ${this.consecutiveRunnerFailures} failures. Last error: ${errorMessage}`
      );
      this.consecutiveRunnerFailures = 0;
    }
  }

  private markRunnerSuccess(): void {
    this.consecutiveRunnerFailures = 0;
    this.runnerOpenUntil = 0;
  }

  private isInvalidArgumentError(message: string | undefined): boolean {
    if (!message) {
      return false;
    }
    return (
      /invalid argument/i.test(message) || /Request contains an invalid argument/i.test(message)
    );
  }

  private isGeminiCompressPassthrough(
    provider: string,
    isPassthrough: boolean,
    normalizedInput: string
  ): boolean {
    if (provider !== 'gemini' || !isPassthrough) {
      return false;
    }
    const trimmed = normalizedInput.trim();
    return trimmed.startsWith('/compress') || trimmed.startsWith('/compact');
  }

  private async callRunner(payload: RunnerRequest): Promise<RunnerResponse> {
    if (!this.runnerEndpoint) {
      return { ok: false, error: 'RUNNER_ENDPOINT is not configured.' };
    }

    const body = JSON.stringify(payload);
    const endpoint = new URL(`${this.runnerEndpoint}/run`);
    const transport = endpoint.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString()
    };
    if (this.runnerToken) {
      headers['x-runner-token'] = this.runnerToken;
    }

    try {
      const response = await new Promise<{ statusCode: number; bodyText: string }>(
        (resolve, reject) => {
          const req = transport.request({
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port || undefined,
            path: `${endpoint.pathname}${endpoint.search}`,
            method: 'POST',
            headers
          });

          req.setTimeout(this.runnerTimeoutMs, () => {
            req.destroy(new Error(`Runner request timed out after ${this.runnerTimeoutMs}ms`));
          });

          req.on('response', (res) => {
            let responseText = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              responseText += chunk;
            });
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode || 0,
                bodyText: responseText
              });
            });
          });

          req.on('error', (error) => {
            reject(error);
          });

          req.write(body);
          req.end();
        }
      );

      if (response.statusCode < 200 || response.statusCode >= 300) {
        return { ok: false, error: `Runner HTTP ${response.statusCode}: ${response.bodyText}` };
      }

      const result = JSON.parse(response.bodyText || '{}') as RunnerResponse;
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Runner request failed: ${message}` };
    }
  }

  private async executeLocal(
    task: RunnerTask,
    provider: string,
    input: string,
    options?: AIAgentOptions
  ): Promise<string> {
    // 直接傳遞所有 options（包含 isPassthroughCommand）
    const mergedOptions: AIAgentOptions = { ...options };

    if (provider === 'opencode') {
      if (task === 'chat') {
        const response = await this.opencodeAgent.chat(input, mergedOptions);
        return `[Opencode] ${response}`;
      }
      return this.opencodeAgent.summarize(input, mergedOptions);
    }

    if (task === 'chat') {
      const response = await this.geminiAgent.chat(input, mergedOptions);
      return `[Gemini] ${response}`;
    }
    return this.geminiAgent.summarize(input, mergedOptions);
  }

  private async executeTask(
    task: RunnerTask,
    input: string,
    options?: AIAgentOptions
  ): Promise<string> {
    const config = this.loadProviderConfig();
    const provider = config.provider === 'opencode' ? 'opencode' : 'gemini';
    const model = options?.model || config.model;

    // 完整傳遞所有 options（包含 isPassthroughCommand）
    const mergedOptions: AIAgentOptions = { ...options };
    if (model) {
      mergedOptions.model = model;
    }

    const isPassthrough = options?.isPassthroughCommand === true;
    const forceNewSession = options?.forceNewSession === true;
    const normalizedInput = this.normalizePassthroughInput(input, provider, isPassthrough);
    if (isPassthrough) {
      console.log('[DynamicAgent] Passthrough command detected.');
    }

    console.log(
      `[DynamicAgent] Provider: ${provider}, Model: ${model || 'default'}, PreferRunner: ${this.preferRunner}`
    );

    if (this.preferRunner && this.runnerEndpoint) {
      if (this.isRunnerCircuitOpen()) {
        const remainingMs = this.runnerOpenUntil - Date.now();
        console.warn(`[DynamicAgent] Runner circuit open, skip runner for ${remainingMs}ms.`);
        if (!this.fallbackToLocal) {
          return `Error calling runner: circuit open (${remainingMs}ms remaining)`;
        }
        return this.executeLocal(task, provider, input, mergedOptions);
      }

      const runnerPayload: RunnerRequest = {
        task,
        input: normalizedInput,
        provider,
        ...(isPassthrough ? { isPassthroughCommand: true } : {}),
        ...(forceNewSession ? { forceNewSession: true } : {})
      };
      if (model) {
        runnerPayload.model = model;
      }

      let runnerResult = await this.callRunner(runnerPayload);
      const isCompressPassthrough = this.isGeminiCompressPassthrough(
        provider,
        isPassthrough,
        normalizedInput
      );

      if (
        !runnerResult.ok &&
        isCompressPassthrough &&
        !forceNewSession &&
        this.isInvalidArgumentError(runnerResult.error)
      ) {
        console.warn(
          '[DynamicAgent] /compress failed with invalid argument; retrying once with forceNewSession.'
        );
        const retryPayload: RunnerRequest = {
          ...runnerPayload,
          forceNewSession: true
        };
        runnerResult = await this.callRunner(retryPayload);
      }

      if (runnerResult.ok && runnerResult.output) {
        this.markRunnerSuccess();
        const runnerMeta = runnerResult.requestId ? ` requestId=${runnerResult.requestId}` : '';
        const durationMeta =
          typeof runnerResult.durationMs === 'number'
            ? ` duration=${runnerResult.durationMs}ms`
            : '';
        console.log(`[DynamicAgent] Runner success.${runnerMeta}${durationMeta}`);
        if (task === 'chat') {
          const providerLabel = runnerResult.provider === 'opencode' ? 'Opencode' : 'Gemini';
          return `[${providerLabel}] ${runnerResult.output}`;
        }
        return runnerResult.output;
      }

      const errorMessage = runnerResult.error || 'Unknown runner error';
      if (isCompressPassthrough && this.isInvalidArgumentError(errorMessage)) {
        return '⚠️ `/compress` 失敗：目前這個 Session 的壓縮請求被 Gemini API 拒絕（invalid argument）。請先送 `/new`，再重試 `/compress`。';
      }
      this.markRunnerFailure(errorMessage);
      console.warn(`[DynamicAgent] Runner failed: ${errorMessage}`);
      if (!this.fallbackToLocal) {
        return `Error calling runner: ${errorMessage}`;
      }
      console.log('[DynamicAgent] Falling back to local execution...');
    }

    return this.executeLocal(task, provider, normalizedInput, mergedOptions);
  }

  private normalizePassthroughInput(
    input: string,
    provider: string,
    isPassthrough: boolean
  ): string {
    if (!isPassthrough) {
      return input;
    }

    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return input;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]?.split('@')[0] || '';

    if (provider === 'opencode' && cmd === '/compress') {
      const rewritten = ['/compact', ...parts.slice(1)].join(' ');
      console.log(
        '[DynamicAgent] Rewriting passthrough command /compress -> /compact for opencode.'
      );
      return rewritten;
    }

    if (provider === 'gemini' && cmd === '/compact') {
      const rewritten = ['/compress', ...parts.slice(1)].join(' ');
      console.log('[DynamicAgent] Rewriting passthrough command /compact -> /compress for gemini.');
      return rewritten;
    }

    return input;
  }

  /**
   * 載入設定檔
   * 若檔案不存在或解析失敗，回退至預設值 { provider: 'gemini' }
   */
  private loadProviderConfig(): AIConfig {
    try {
      const fileContent = fs.readFileSync(this.configPath, 'utf8');
      const config = yaml.load(fileContent) as AIConfig;
      return {
        provider: config?.provider || 'gemini',
        model: config?.model
      };
    } catch {
      // 檔案不存在或解析失敗，使用預設值
      return { provider: 'gemini' };
    }
  }

  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    return this.executeTask('chat', prompt, options);
  }

  async summarize(text: string, options?: AIAgentOptions): Promise<string> {
    return this.executeTask('summarize', text, options);
  }
}
