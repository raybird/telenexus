import http from 'http';
import https from 'https';
import { OpencodeAgent } from './opencode.js';
import type { AgentEvent, AgentStructuredResult } from './agent-result.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { createLogger } from './logger.js';
import { loadAiConfig, resolveOverridePath } from './config-loader.js';

const logger = createLogger('DynamicAgent');

export interface AIAgentOptions {
  model?: string;
  requestId?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
  autoRecoveryNotice?: boolean;
  autoCompressAttempted?: boolean;
  fromScheduler?: boolean;
  signal?: AbortSignal;
}

type RunnerTask = 'chat' | 'summarize';

interface RunnerRequest {
  task: RunnerTask;
  input: string;
  provider: string;
  model?: string;
  requestId?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
  autoRecoveryNotice?: boolean;
  lane?: 'interactive' | 'scheduled';
}

interface RunnerResponse {
  ok: boolean;
  output?: string;
  structured?: AgentStructuredResult;
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
  streamChat?(
    prompt: string,
    options: AIAgentOptions | undefined,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<AgentStructuredResult>;
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
    recordRuntimeIssue('runner:request', errorMessage);
    if (this.consecutiveRunnerFailures >= this.runnerFailureThreshold) {
      this.runnerOpenUntil = Date.now() + this.runnerCooldownMs;
      recordRuntimeIssue(
        'runner:circuit-open',
        `opened for ${this.runnerCooldownMs}ms after ${this.runnerFailureThreshold} failures`
      );
      logger.warn('circuit_open', {
        cooldownMs: this.runnerCooldownMs,
        failures: this.consecutiveRunnerFailures,
        lastErr: errorMessage
      });
      this.consecutiveRunnerFailures = 0;
    }
  }

  private markRunnerSuccess(): void {
    this.consecutiveRunnerFailures = 0;
    this.runnerOpenUntil = 0;
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
    if (payload.requestId) {
      headers['x-request-id'] = payload.requestId;
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

  private async callRunnerStream(
    payload: RunnerRequest,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<RunnerResponse> {
    if (!this.runnerEndpoint) {
      return { ok: false, error: 'RUNNER_ENDPOINT is not configured.' };
    }

    const body = JSON.stringify(payload);
    const endpoint = new URL(`${this.runnerEndpoint}/run/stream`);
    const transport = endpoint.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString()
    };
    if (this.runnerToken) {
      headers['x-runner-token'] = this.runnerToken;
    }
    if (payload.requestId) {
      headers['x-request-id'] = payload.requestId;
    }

    try {
      return await new Promise<RunnerResponse>((resolve, reject) => {
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
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            let bodyText = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              bodyText += chunk;
            });
            res.on('end', () => {
              resolve({ ok: false, error: `Runner HTTP ${res.statusCode}: ${bodyText}` });
            });
            return;
          }

          let buffer = '';
          let finalResult: RunnerResponse | null = null;
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buffer += chunk;
            let splitIndex = buffer.indexOf('\n\n');
            while (splitIndex !== -1) {
              const rawEvent = buffer.slice(0, splitIndex);
              buffer = buffer.slice(splitIndex + 2);
              splitIndex = buffer.indexOf('\n\n');

              const lines = rawEvent.split('\n');
              let eventName = 'message';
              let dataText = '';
              for (const line of lines) {
                if (line.startsWith('event:')) {
                  eventName = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  dataText += line.slice(5).trim();
                }
              }
              if (!dataText) {
                continue;
              }

              let payload: Record<string, unknown>;
              try {
                payload = JSON.parse(dataText) as Record<string, unknown>;
              } catch {
                continue;
              }

              if (eventName === 'start' && typeof payload.provider === 'string') {
                void onEvent({
                  type: 'start',
                  provider: payload.provider as 'opencode'
                });
                continue;
              }
              if (eventName === 'status' && typeof payload.text === 'string') {
                void onEvent({ type: 'status', text: payload.text });
                continue;
              }
              if (eventName === 'reasoning' && typeof payload.text === 'string') {
                void onEvent({ type: 'reasoning', text: payload.text });
                continue;
              }
              if (eventName === 'delta' && typeof payload.text === 'string') {
                void onEvent({ type: 'delta', text: payload.text });
                continue;
              }
              if (eventName === 'usage' && payload.stats !== undefined) {
                void onEvent({ type: 'usage', stats: payload.stats });
                continue;
              }
              if (eventName === 'error' && typeof payload.message === 'string') {
                void onEvent({ type: 'error', message: payload.message });
                continue;
              }
              if (eventName === 'done' && typeof payload.text === 'string') {
                void onEvent({ type: 'done', text: payload.text });
                continue;
              }
              if (eventName === 'result') {
                finalResult = payload as unknown as RunnerResponse;
              }
            }
          });

          res.on('end', () => {
            resolve(finalResult || { ok: false, error: 'Runner stream ended without result.' });
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.write(body);
        req.end();
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Runner request failed: ${message}` };
    }
  }

  private async executeLocal(
    task: RunnerTask,
    input: string,
    options?: AIAgentOptions
  ): Promise<string> {
    const mergedOptions: AIAgentOptions = { ...options };

    if (task === 'chat') {
      const response = await this.opencodeAgent.chatStructured(input, mergedOptions);
      return `[Opencode] ${response.text}`;
    }
    return this.opencodeAgent.summarize(input, mergedOptions);
  }

  async streamChat(
    prompt: string,
    options: AIAgentOptions | undefined,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<AgentStructuredResult> {
    const config = this.loadProviderConfig();
    const provider = 'opencode';
    const model = options?.model || config.model;
    const mergedOptions: AIAgentOptions = { ...options };
    if (model) {
      mergedOptions.model = model;
    }

    const normalizedInput = this.normalizePassthroughInput(
      prompt,
      mergedOptions.isPassthroughCommand === true
    );

    if (this.preferRunner && this.runnerEndpoint) {
      if (this.isRunnerCircuitOpen()) {
        const remainingMs = this.runnerOpenUntil - Date.now();
        recordRuntimeIssue('runner:circuit-open', `skip runner stream for ${remainingMs}ms`);
        if (!this.fallbackToLocal) {
          const message = `Error calling runner: circuit open (${remainingMs}ms remaining)`;
          await onEvent({ type: 'error', message });
          return { provider, text: message };
        }
      } else {
        const runnerPayload: RunnerRequest = {
          task: 'chat',
          input: normalizedInput,
          provider,
          ...(mergedOptions.requestId ? { requestId: mergedOptions.requestId } : {}),
          ...(mergedOptions.isPassthroughCommand ? { isPassthroughCommand: true } : {}),
          ...(mergedOptions.forceNewSession ? { forceNewSession: true } : {}),
          ...(mergedOptions.autoRecoveryNotice ? { autoRecoveryNotice: true } : {}),
          lane: mergedOptions.fromScheduler ? 'scheduled' : 'interactive'
        };
        if (model) {
          runnerPayload.model = model;
        }

        const runnerResult = await this.callRunnerStream(runnerPayload, onEvent);
        if (runnerResult.ok && runnerResult.output) {
          this.markRunnerSuccess();
          const rawText = runnerResult.structured?.text || runnerResult.output;
          const text = `[Opencode] ${rawText}`;
          return {
            provider: 'opencode',
            text,
            ...(runnerResult.structured?.sessionId
              ? { sessionId: runnerResult.structured.sessionId }
              : {}),
            ...(runnerResult.structured?.stats !== undefined
              ? { stats: runnerResult.structured.stats }
              : {})
          };
        }

        const errorMessage = runnerResult.error || 'Unknown runner error';
        this.markRunnerFailure(errorMessage);
        if (!this.fallbackToLocal) {
          await onEvent({ type: 'error', message: `Error calling runner: ${errorMessage}` });
          return { provider, text: `Error calling runner: ${errorMessage}` };
        }
      }
    }

    if (this.opencodeAgent.streamChat) {
      const result = await this.opencodeAgent.streamChat(normalizedInput, mergedOptions, onEvent);
      return { ...result, text: `[Opencode] ${result.text}` };
    }

    await onEvent({ type: 'start', provider });
    const text = await this.executeTask('chat', normalizedInput, mergedOptions);
    await onEvent({ type: 'done', text });
    return {
      provider,
      text
    };
  }

  private async executeTask(
    task: RunnerTask,
    input: string,
    options?: AIAgentOptions
  ): Promise<string> {
    const config = this.loadProviderConfig();
    const provider = 'opencode';
    const model = options?.model || config.model;

    // 完整傳遞所有 options（包含 isPassthroughCommand）
    const mergedOptions: AIAgentOptions = { ...options };
    if (model) {
      mergedOptions.model = model;
    }

    const isPassthrough = options?.isPassthroughCommand === true;
    const forceNewSession = options?.forceNewSession === true;
    const autoRecoveryNotice = options?.autoRecoveryNotice === true;
    const normalizedInput = this.normalizePassthroughInput(input, isPassthrough);
    if (isPassthrough) {
      logger.info('passthrough_detected');
    }

    logger.info('execute', {
      provider,
      model: model || 'default',
      preferRunner: this.preferRunner
    });

    if (this.preferRunner && this.runnerEndpoint) {
      if (this.isRunnerCircuitOpen()) {
        const remainingMs = this.runnerOpenUntil - Date.now();
        logger.warn('circuit_skip', { remainingMs });
        recordRuntimeIssue('runner:circuit-open', `skip runner for ${remainingMs}ms`);
        if (!this.fallbackToLocal) {
          return `Error calling runner: circuit open (${remainingMs}ms remaining)`;
        }
        return this.executeLocal(task, input, mergedOptions);
      }

      const runnerPayload: RunnerRequest = {
        task,
        input: normalizedInput,
        provider,
        ...(mergedOptions.requestId ? { requestId: mergedOptions.requestId } : {}),
        ...(isPassthrough ? { isPassthroughCommand: true } : {}),
        ...(forceNewSession ? { forceNewSession: true } : {}),
        ...(autoRecoveryNotice ? { autoRecoveryNotice: true } : {}),
        lane: mergedOptions.fromScheduler ? 'scheduled' : 'interactive'
      };
      if (model) {
        runnerPayload.model = model;
      }

      const runnerResult = await this.callRunner(runnerPayload);

      if (runnerResult.ok && runnerResult.output) {
        this.markRunnerSuccess();
        logger.info('runner_success', {
          requestId: runnerResult.requestId,
          durationMs: runnerResult.durationMs
        });
        const outputText = runnerResult.structured?.text || runnerResult.output;
        if (task === 'chat') {
          return `[Opencode] ${outputText}`;
        }
        return outputText;
      }

      const errorMessage = runnerResult.error || 'Unknown runner error';
      this.markRunnerFailure(errorMessage);
      logger.warn('runner_failed', { err: errorMessage });
      if (!this.fallbackToLocal) {
        return `Error calling runner: ${errorMessage}`;
      }
      logger.info('fallback');
    }

    return this.executeLocal(task, normalizedInput, mergedOptions);
  }

  private normalizePassthroughInput(input: string, isPassthrough: boolean): string {
    if (!isPassthrough) {
      return input;
    }

    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return input;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]?.split('@')[0] || '';

    if (cmd === '/compress') {
      const rewritten = ['/compact', ...parts.slice(1)].join(' ');
      logger.info('rewrite_compress');
      return rewritten;
    }

    return input;
  }

  private loadProviderConfig(): AIConfig {
    return loadAiConfig({ basePath: this.configPath });
  }

  resolveOverridePath(): string {
    return resolveOverridePath();
  }

  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    return this.executeTask('chat', prompt, options);
  }

  async summarize(text: string, options?: AIAgentOptions): Promise<string> {
    return this.executeTask('summarize', text, options);
  }
}
