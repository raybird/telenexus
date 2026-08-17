import { spawn } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AIAgent, AIAgentOptions } from './agent.js';
import { terminateProcessTree, trackChildProcess } from './process-runner.js';
import {
  buildTextOnlyStructuredResult,
  type AgentEvent,
  type AgentProvider,
  type AgentStructuredResult
} from './agent-result.js';
import { ProcessError } from './process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { createLogger } from './logger.js';

export type CliStreamParse = {
  sessionId?: string;
  deltaText?: string;
  reasoningText?: string;
  statusText?: string;
  stats?: Record<string, unknown>;
  emitStart?: boolean;
};

export type CliAgentConfig = {
  provider: AgentProvider;
  binary: string;
  rateLimitPattern: RegExp;
  rateLimitMessage: string;
  timeoutMessage: string;
  streamTimeoutMs?: number;
};

const logger = createLogger('CliAgent');

const DEFAULT_STREAM_HEARTBEAT_MS = 20000;

function getStreamHeartbeatMs(): number {
  const raw = Number.parseInt(process.env.CLI_AGENT_STREAM_HEARTBEAT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_HEARTBEAT_MS;
}

/**
 * 共通的 CLI agent 基底：
 * 負責 streamChat 的 spawn / stdout 緩衝 / stderr 掃描 / timeout / rate-limit fail-fast
 * 子類提供 buildChatArgs / parseStreamLine / cleanOutput / cwd / env / chatStructured fallback
 */
export abstract class CliAgentBase implements AIAgent {
  protected abstract readonly config: CliAgentConfig;

  protected abstract buildChatArgs(options?: AIAgentOptions): string[];
  protected abstract parseStreamLine(line: string): CliStreamParse | null;
  protected abstract cleanOutput(text: string): string;

  abstract chatStructured(
    prompt: string,
    options?: AIAgentOptions
  ): Promise<AgentStructuredResult>;
  abstract summarize(text: string, options?: AIAgentOptions): Promise<string>;

  protected getCwd(): string {
    return 'workspace';
  }

  protected getEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  protected getVerboseStdoutPath(): string | null {
    return null;
  }

  private initVerboseLog(verbosePath: string): void {
    try {
      fs.mkdirSync(path.dirname(verbosePath), { recursive: true });
      fs.writeFileSync(verbosePath, '', 'utf8');
    } catch {
      // best-effort
    }
  }

  private appendVerboseLine(verbosePath: string, line: string): void {
    try {
      fs.appendFileSync(verbosePath, line + '\n', 'utf8');
    } catch {
      // best-effort
    }
  }

  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    const result = await this.chatStructured(prompt, options);
    return result.text;
  }

  /**
   * 一輪 CLI 執行結束後的收尾,成功/失敗/逾時/中止四條路徑都會走到。預設 no-op。
   *
   * 存在的理由:CLI 可能長出**不在我們 process group 裡**的常駐程序(agent-browser 就是,
   * 實測它 setsid 出去、PPID=1、PGID 與呼叫方不同),terminateProcessTree() 打不到,
   * 只能由知道該工具契約的子類明確收掉。
   */
  protected async onRunFinished(_options?: AIAgentOptions): Promise<void> {
    // 預設不做事。
  }

  async streamChat(
    prompt: string,
    options: AIAgentOptions | undefined,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<AgentStructuredResult> {
    try {
      return await this.runStreamChat(prompt, options, onEvent);
    } finally {
      await this.onRunFinished(options);
    }
  }

  protected async runStreamChat(
    prompt: string,
    options: AIAgentOptions | undefined,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<AgentStructuredResult> {
    const { provider } = this.config;
    if (options?.isPassthroughCommand) {
      const fallback = await this.chatStructured(prompt, options);
      await onEvent({ type: 'start', provider });
      if (fallback.stats !== undefined) {
        await onEvent({ type: 'usage', stats: fallback.stats });
      }
      await onEvent({ type: 'done', text: fallback.text });
      return fallback;
    }

    const verbosePath = this.getVerboseStdoutPath();
    if (verbosePath) {
      this.initVerboseLog(verbosePath);
    }

    const args = this.buildChatArgs(options);
    const child = spawn(this.config.binary, [...args, prompt], {
      cwd: this.getCwd(),
      env: this.getEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // 與 process-runner 同理:CLI 會再長出 agent-browser 與整棵 Chrome,
      // 不自成 process group 就只殺得到直接 child。這條是串流(互動聊天)路徑。
      detached: process.platform !== 'win32'
    });
    trackChildProcess(child);

    let stdoutBuffer = '';
    let stderr = '';
    let aggregatedText = '';
    let parsedLineCount = 0;
    let sessionId: string | undefined;
    let stats: Record<string, unknown> | undefined;
    let started = false;
    let settled = false;
    let timedOut = false;
    let rateLimited = false;
    let externallyAborted = false;

    const onAbort = () => {
      externallyAborted = true;
      terminateProcessTree(child);
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let lastDeltaAt = Date.now();
    let lastStatusAt = 0;
    let lastStatusText = '';
    const streamTimeoutMs = this.config.streamTimeoutMs ?? 1800000;
    const heartbeatMs = getStreamHeartbeatMs();
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, streamTimeoutMs);

    const emitStart = async (): Promise<void> => {
      if (started) {
        return;
      }
      started = true;
      await onEvent({ type: 'start', provider });
    };

    const emitStatus = async (text: string): Promise<void> => {
      const normalized = text.trim();
      if (!normalized) {
        return;
      }
      const now = Date.now();
      if (normalized === lastStatusText && now - lastStatusAt < heartbeatMs) {
        return;
      }
      lastStatusText = normalized;
      lastStatusAt = now;
      await emitStart();
      await onEvent({ type: 'status', text: normalized });
    };

    const heartbeatInterval = setInterval(() => {
      if (settled || heartbeatMs <= 0) {
        return;
      }
      const now = Date.now();
      if (now - lastDeltaAt >= heartbeatMs && now - lastStatusAt >= heartbeatMs) {
        void emitStatus('仍在等待模型輸出...').catch(() => {
          // Status updates are best-effort; model output should continue even if UI updates fail.
        });
      }
    }, Math.max(1000, Math.min(heartbeatMs, 5000)));

    return new Promise<AgentStructuredResult>((resolve, reject) => {
      child.stdout?.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';

        void (async () => {
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) {
              continue;
            }
            if (verbosePath) {
              this.appendVerboseLine(verbosePath, line);
            }
            const parsed = this.parseStreamLine(line);
            if (!parsed) {
              continue;
            }
            parsedLineCount += 1;
            if (parsed.sessionId) {
              sessionId = parsed.sessionId;
            }
            if (parsed.emitStart) {
              await emitStart();
            }
            if (parsed.statusText) {
              await emitStatus(parsed.statusText);
            }
            if (typeof parsed.reasoningText === 'string' && parsed.reasoningText.length > 0) {
              // 思考片段視為「活動中」，避免心跳誤判為靜默而插入等待提示
              lastDeltaAt = Date.now();
              await emitStart();
              await onEvent({ type: 'reasoning', text: parsed.reasoningText });
            }
            if (typeof parsed.deltaText === 'string' && parsed.deltaText.length > 0) {
              lastDeltaAt = Date.now();
              await emitStart();
              aggregatedText += parsed.deltaText;
              await onEvent({ type: 'delta', text: parsed.deltaText });
            }
            if (parsed.stats) {
              stats = parsed.stats;
            }
          }
        })().catch((error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearInterval(heartbeatInterval);
          reject(error);
        });
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        if (!rateLimited && this.config.rateLimitPattern.test(stderr)) {
          rateLimited = true;
          clearTimeout(timer);
          clearInterval(heartbeatInterval);
          terminateProcessTree(child);
        }
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(heartbeatInterval);
        reject(error);
      });

      child.on('close', (code, signal) => {
        void (async () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearInterval(heartbeatInterval);
          options?.signal?.removeEventListener('abort', onAbort);

          if (stdoutBuffer.trim()) {
            const trailing = this.parseStreamLine(stdoutBuffer.trim());
            if (trailing?.stats) {
              stats = trailing.stats;
            }
            if (typeof trailing?.deltaText === 'string' && trailing.deltaText.length > 0) {
              aggregatedText += trailing.deltaText;
            }
          }

          if (externallyAborted) {
            const abortedResult = buildTextOnlyStructuredResult(provider, '⏹️ 任務已被使用者中止。');
            if (!started) {
              await emitStart();
            }
            await onEvent({ type: 'done', text: abortedResult.text });
            resolve(abortedResult);
            return;
          }

          if (signal || (code && code !== 0)) {
            if (rateLimited) {
              console.warn(`[${provider}] streamChat fail-fast on upstream 429.`);
              recordRuntimeIssue(
                `${provider}:rate-limit`,
                new Error('streamChat upstream 429')
              );
              const rlResult = buildTextOnlyStructuredResult(
                provider,
                this.config.rateLimitMessage
              );
              if (!started) {
                await emitStart();
              }
              await onEvent({ type: 'done', text: rlResult.text });
              resolve(rlResult);
              return;
            }
            if (timedOut || signal === 'SIGTERM') {
              const timeoutResult = buildTextOnlyStructuredResult(
                provider,
                this.config.timeoutMessage
              );
              await onEvent({ type: 'error', message: timeoutResult.text });
              resolve(timeoutResult);
              return;
            }

            if (aggregatedText.trim()) {
              aggregatedText = this.cleanOutput(aggregatedText);
              if (!started) {
                await emitStart();
              }
              if (stats !== undefined) {
                await onEvent({ type: 'usage', stats });
              }
              await onEvent({ type: 'done', text: aggregatedText });
              resolve({
                provider,
                text: aggregatedText,
                ...(sessionId ? { sessionId } : {}),
                ...(stats !== undefined ? { stats } : {})
              });
              return;
            }

            const fields: { code?: string | number; signal?: string; stderr?: string } = {
              stderr
            };
            if (code !== null && code !== undefined) {
              fields.code = code;
            }
            if (signal) {
              fields.signal = signal;
            }
            reject(
              new ProcessError(`Error calling ${provider}: exit=${code || 0}`, fields)
            );
            return;
          }

          if (!aggregatedText.trim()) {
            const reason = parsedLineCount === 0 ? 'no_events' : 'tool_only';
            recordRuntimeIssue(
              `${provider}:empty-output:${reason}`,
              new Error(`stream ended with empty output (${reason})`)
            );

            if (reason === 'tool_only') {
              logger.warn('empty_output_follow_up', { reason });
              const followUp = await this.chatStructured(
                '請整理你剛才工具執行的結果並回答原問題',
                options
              );
              if (!started) {
                await emitStart();
              }
              if (followUp.stats !== undefined) {
                await onEvent({ type: 'usage', stats: followUp.stats });
              }
              await onEvent({ type: 'done', text: followUp.text });
              resolve(followUp);
              return;
            }

            logger.warn('empty_output_no_events');
            const emptyResult = buildTextOnlyStructuredResult(
              provider,
              'Opencode 沒有任何輸出，請重試。'
            );
            if (!started) {
              await emitStart();
            }
            await onEvent({ type: 'done', text: emptyResult.text });
            resolve(emptyResult);
            return;
          }

          const rawLen = aggregatedText.length;
          aggregatedText = this.cleanOutput(aggregatedText);
          if (!aggregatedText.trim()) {
            recordRuntimeIssue(
              `${provider}:empty-output:text_filtered_out`,
              new Error('stream text was entirely filtered by cleanOutput')
            );
            logger.warn('text_filtered_out', { rawLen, verbosePath: verbosePath ?? '(not set)' });
            const filteredResult = buildTextOnlyStructuredResult(
              provider,
              '模型輸出被清洗規則濾光，已記錄原始內容。'
            );
            if (!started) {
              await emitStart();
            }
            await onEvent({ type: 'done', text: filteredResult.text });
            resolve(filteredResult);
            return;
          }

          if (!started) {
            await emitStart();
          }
          if (stats !== undefined) {
            await onEvent({ type: 'usage', stats });
          }
          await onEvent({ type: 'done', text: aggregatedText });
          resolve({
            provider,
            text: aggregatedText,
            ...(sessionId ? { sessionId } : {}),
            ...(stats !== undefined ? { stats } : {})
          });
        })().catch((error) => {
          reject(error);
        });
      });
    });
  }
}
