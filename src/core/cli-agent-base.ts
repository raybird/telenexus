import { spawn } from 'child_process';
import type { AIAgent, AIAgentOptions } from './agent.js';
import {
  buildTextOnlyStructuredResult,
  type AgentEvent,
  type AgentProvider,
  type AgentStructuredResult
} from './agent-result.js';
import { ProcessError } from './process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';

export type CliStreamParse = {
  sessionId?: string;
  deltaText?: string;
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

  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    const result = await this.chatStructured(prompt, options);
    return result.text;
  }

  async streamChat(
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

    const args = this.buildChatArgs(options);
    const child = spawn(this.config.binary, [...args, prompt], {
      cwd: this.getCwd(),
      env: this.getEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let stderr = '';
    let aggregatedText = '';
    let sessionId: string | undefined;
    let stats: Record<string, unknown> | undefined;
    let started = false;
    let settled = false;
    let timedOut = false;
    let rateLimited = false;
    const streamTimeoutMs = this.config.streamTimeoutMs ?? 1800000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, streamTimeoutMs);

    const emitStart = async (): Promise<void> => {
      if (started) {
        return;
      }
      started = true;
      await onEvent({ type: 'start', provider });
    };

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
            const parsed = this.parseStreamLine(line);
            if (!parsed) {
              continue;
            }
            if (parsed.sessionId) {
              sessionId = parsed.sessionId;
            }
            if (parsed.emitStart) {
              await emitStart();
            }
            if (typeof parsed.deltaText === 'string' && parsed.deltaText.length > 0) {
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
          reject(error);
        });
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        if (!rateLimited && this.config.rateLimitPattern.test(stderr)) {
          rateLimited = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
        }
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code, signal) => {
        void (async () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);

          if (stdoutBuffer.trim()) {
            const trailing = this.parseStreamLine(stdoutBuffer.trim());
            if (trailing?.stats) {
              stats = trailing.stats;
            }
            if (typeof trailing?.deltaText === 'string' && trailing.deltaText.length > 0) {
              aggregatedText += trailing.deltaText;
            }
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
            const fallback = await this.chatStructured(prompt, options);
            if (!started) {
              await emitStart();
            }
            if (fallback.stats !== undefined) {
              await onEvent({ type: 'usage', stats: fallback.stats });
            }
            await onEvent({ type: 'done', text: fallback.text });
            resolve(fallback);
            return;
          }

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
        })().catch((error) => {
          reject(error);
        });
      });
    });
  }
}
