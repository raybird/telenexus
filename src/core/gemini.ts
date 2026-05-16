import { spawn } from 'child_process';
import type { AIAgent, AIAgentOptions } from './agent.js';
import {
  buildTextOnlyStructuredResult,
  type AgentEvent,
  type AgentStructuredResult
} from './agent-result.js';
import { ProcessError, runProcess } from './process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';

type GeminiJsonOutput = {
  session_id?: string;
  response?: string;
  stats?: unknown;
};

type GeminiStreamEvent = {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  stats?: unknown;
};

export function parseGeminiJsonOutput(stdout: string): AgentStructuredResult | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as GeminiJsonOutput;
    if (typeof parsed.response !== 'string') {
      return null;
    }

    const result: AgentStructuredResult = {
      provider: 'gemini',
      text: parsed.response.trim() || 'Gemini 執行完成，但沒有返回任何文字內容。',
      raw: parsed
    };

    if (typeof parsed.session_id === 'string' && parsed.session_id.trim().length > 0) {
      result.sessionId = parsed.session_id;
    }
    if (parsed.stats !== undefined) {
      result.stats = parsed.stats;
    }
    return result;
  } catch {
    return null;
  }
}

export class GeminiAgent implements AIAgent {
  private isCompressCommand(prompt: string): boolean {
    const trimmed = prompt.trim();
    return trimmed.startsWith('/compress') || trimmed.startsWith('/compact');
  }

  private isInvalidArgument(stderr: string | undefined): boolean {
    if (!stderr) {
      return false;
    }
    return /Request contains an invalid argument/i.test(stderr);
  }

  private isCompressionSignature(stderr: string | undefined): boolean {
    if (!stderr) {
      return false;
    }
    return /ChatCompressionService\.compress|GeminiClient\.tryCompressChat|Failed to compress chat history/i.test(
      stderr
    );
  }

  /**
   * 清除輸出中的 <thinking> 區塊和其他雜訊
   */
  private cleanOutput(text: string): string {
    // 1. 移除 <thinking>...</thinking> 區塊 (包含 XML 和 HTML 樣式)
    let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    // 2. 移除所有 ANSI 控制字元與顏色碼
    // eslint-disable-next-line no-control-regex
    cleaned = cleaned.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ''
    );

    return cleaned.trim();
  }

  private recoverOutputFromError(error: unknown): string | null {
    const raw = error instanceof ProcessError ? error.stdout || '' : '';
    const cleaned = this.cleanOutput(raw);
    if (!cleaned) {
      return null;
    }

    // 僅有極短「準備執行」敘述時，視為不可用片段
    if (cleaned.length < 60 && /^(我將|我會|I'll|I will)/i.test(cleaned)) {
      return null;
    }

    return cleaned;
  }

  private buildChatArgs(
    prompt: string,
    options?: AIAgentOptions,
    outputFormat: 'json' | 'stream-json' | null = 'json'
  ): string[] {
    const isPassthrough = options?.isPassthroughCommand === true;
    const forceNewSession = options?.forceNewSession === true;
    const args = ['--yolo'];
    if (!forceNewSession) {
      args.push('-r');
    }
    args.push('-p', prompt);
    if (!isPassthrough && outputFormat) {
      args.push('--output-format', outputFormat);
    }
    if (options?.model) {
      args.push('--model', options.model);
    }
    return args;
  }

  private async executeChatProcess(
    prompt: string,
    options?: AIAgentOptions
  ): Promise<{ stdout: string; stderr: string }> {
    const isPassthrough = options?.isPassthroughCommand === true;
    const args = this.buildChatArgs(prompt, options, 'json');

    if (isPassthrough) {
      console.log(`[Gemini] isPassthroughCommand: true`);
      console.log(`[Gemini] Original prompt: ${prompt}`);
      console.log(
        `[Gemini] Executing passthrough via -p only: gemini ${args.join(' ')} (hook bypass)`
      );
    } else if (options?.model) {
      console.log(`[Gemini] Executing (YOLO Mode) with model: ${options.model}`);
    } else {
      console.log(`[Gemini] Executing (YOLO Mode): gemini ${args.join(' ')} ...`);
    }

    return runProcess('gemini', args, {
      timeoutMs: 660000,
      cwd: 'workspace',
      env: {
        ...process.env,
        GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR || process.cwd(),
        GEMINI_BYPASS_MEMORY_HOOK: '1'
      },
      abortOnStderr: {
        pattern: /(status|code)\s*[:=]?\s*429|RESOURCE_EXHAUSTED/i,
        code: 'ERATELIMIT',
        message: 'Gemini upstream rate-limited (HTTP 429); aborted before internal backoff retries.'
      }
    });
  }

  private toStructuredResult(stdout: string, options?: AIAgentOptions): AgentStructuredResult {
    if (options?.isPassthroughCommand !== true) {
      const structured = parseGeminiJsonOutput(stdout);
      if (structured) {
        structured.text = this.cleanOutput(structured.text);
        return structured;
      }
    }

    const cleaned = this.cleanOutput(stdout);
    return buildTextOnlyStructuredResult(
      'gemini',
      cleaned || 'Gemini 執行完成，但沒有返回任何文字內容。',
      { raw: stdout }
    );
  }

  /**
   * 生成結構化摘要
   * 格式固定為 Goal/Decision/Todo/Facts 欄位
   */
  async summarize(text: string, options?: AIAgentOptions): Promise<string> {
    try {
      const prompt = `請將以下內容整理成「可供長期檢索」的結構化摘要。

規則：
- 優先保留目標、決策、待辦、關鍵事實。
- 若有明確技術限制、營運規則、SOP、fallback、故障處置，務必寫進 Decision 或 Facts。
- 不要寫抒情、評論、客套話。
- 每個欄位盡量精煉，使用短句或條列。
- 若欄位沒有內容就省略。
- 只輸出下列格式，不要加前言或結語。

格式：

Goal: [目標或意圖，若無則省略]
Decision: [做出的決定，若無則省略]
Todo: [待辦事項，若無則省略]
Facts: [重要事實或資訊]

內容：
${text}

只輸出摘要，不要加任何說明。`;

      const args = ['-p', prompt];

      // 若有指定 model，加入參數
      if (options?.model) {
        args.push('--model', options.model);
      }

      const { stdout } = await runProcess('gemini', args);
      const cleaned = this.cleanOutput(stdout);

      // 驗證摘要長度，過長則截斷
      if (cleaned.length > 280) {
        return cleaned.substring(0, 280) + '...';
      }

      return cleaned || '(摘要失敗)';
    } catch (error: unknown) {
      console.error('[Gemini] Summarization failed:', error);
      const recovered = this.recoverOutputFromError(error);
      if (recovered) {
        return recovered.length > 280 ? recovered.substring(0, 280) + '...' : recovered;
      }
      // Fallback: 截斷原文
      return text.substring(0, 200) + '...';
    }
  }

  async chatStructured(prompt: string, options?: AIAgentOptions): Promise<AgentStructuredResult> {
    try {
      const result = await this.executeChatProcess(prompt, options);
      if (result.stderr && result.stderr.trim().length > 0) {
        console.log(`[Gemini-Tools] Log: ${result.stderr}`);
      }
      return this.toStructuredResult(result.stdout, options);
    } catch (error: unknown) {
      console.error('[Gemini] Execution failed:', error);
      const recovered = this.recoverOutputFromError(error);
      if (recovered) {
        console.warn('[Gemini] Returning recovered stdout despite non-zero exit/signal.');
        return buildTextOnlyStructuredResult('gemini', recovered);
      }

      const isPassthrough = options?.isPassthroughCommand === true;
      const forceNewSession = options?.forceNewSession === true;
      const autoCompressAttempted = options?.autoCompressAttempted === true;
      const autoRecoveryNotice = options?.autoRecoveryNotice === true;
      const stderr = error instanceof ProcessError ? error.stderr || '' : '';

      if (
        isPassthrough &&
        !forceNewSession &&
        this.isCompressCommand(prompt) &&
        this.isInvalidArgument(stderr)
      ) {
        console.warn('[Gemini] /compress invalid argument. Retrying with a new session...');
        return this.chatStructured(prompt, {
          ...options,
          forceNewSession: true
        });
      }

      if (
        !isPassthrough &&
        !forceNewSession &&
        !autoCompressAttempted &&
        this.isInvalidArgument(stderr) &&
        this.isCompressionSignature(stderr)
      ) {
        console.warn(
          '[Gemini] Compression-related invalid argument detected. Auto-running /compress.'
        );
        try {
          const compressOptions: AIAgentOptions = {
            isPassthroughCommand: true,
            autoCompressAttempted: true,
            autoRecoveryNotice: false
          };
          if (options?.model) {
            compressOptions.model = options.model;
          }

          await this.chatStructured('/compress', {
            ...compressOptions
          });

          const recoveredResult = await this.chatStructured(prompt, {
            ...options,
            isPassthroughCommand: false,
            forceNewSession: false,
            autoCompressAttempted: true
          });

          if (autoRecoveryNotice) {
            return {
              ...recoveredResult,
              text: `⚠️ 偵測到 Gemini Session 壓縮異常，已自動執行 /compress 並恢復對話。\n\n${recoveredResult.text}`
            };
          }
          return recoveredResult;
        } catch (recoveryError) {
          console.error('[Gemini] Auto /compress recovery failed:', recoveryError);
        }
      }

      if (error instanceof ProcessError && error.code === 'ERATELIMIT') {
        console.warn('[Gemini] Fail-fast on upstream 429 (rate limit).');
        recordRuntimeIssue('gemini:rate-limit', error);
        return buildTextOnlyStructuredResult(
          'gemini',
          '⏳ Gemini 上游配額已達上限 (HTTP 429)，本次任務已快速中止以避免長時間退避重試。請稍後再試或錯開排程時間。'
        );
      }

      if (
        error instanceof ProcessError &&
        (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')
      ) {
        return buildTextOnlyStructuredResult('gemini', '✨ 10分鐘內未完成');
      }

      const message = error instanceof Error ? error.message : String(error);
      const pe = error instanceof ProcessError ? error : undefined;
      const fields: { code?: string | number; signal?: string; stderr?: string; stdout?: string } =
        {
          stderr,
          stdout: pe?.stdout || ''
        };
      if (pe?.code !== undefined) fields.code = pe.code;
      if (pe?.signal !== undefined) fields.signal = pe.signal;
      throw new ProcessError(`Error calling Gemini: ${message}`, fields);
    }
  }

  async streamChat(
    prompt: string,
    options: AIAgentOptions | undefined,
    onEvent: (event: AgentEvent) => Promise<void> | void
  ): Promise<AgentStructuredResult> {
    if (options?.isPassthroughCommand) {
      const fallback = await this.chatStructured(prompt, options);
      await onEvent({ type: 'start', provider: 'gemini' });
      await onEvent({ type: 'done', text: fallback.text });
      return fallback;
    }

    const args = this.buildChatArgs(prompt, options, 'stream-json');
    const child = spawn('gemini', args, {
      cwd: 'workspace',
      env: {
        ...process.env,
        GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR || process.cwd(),
        GEMINI_BYPASS_MEMORY_HOOK: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let stderr = '';
    let aggregatedText = '';
    let sessionId: string | undefined;
    let stats: unknown;
    let started = false;
    let settled = false;
    let timedOut = false;
    let rateLimited = false;
    const rateLimitPattern = /(status|code)\s*[:=]?\s*429|RESOURCE_EXHAUSTED/i;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 600000);

    const emitStart = async (): Promise<void> => {
      if (started) {
        return;
      }
      started = true;
      await onEvent({ type: 'start', provider: 'gemini' });
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
            try {
              const parsed = JSON.parse(line) as GeminiStreamEvent;
              if (parsed.type === 'init') {
                if (typeof parsed.session_id === 'string' && parsed.session_id.trim().length > 0) {
                  sessionId = parsed.session_id;
                }
                await emitStart();
                continue;
              }
              if (
                parsed.type === 'message' &&
                parsed.role === 'assistant' &&
                typeof parsed.content === 'string'
              ) {
                await emitStart();
                aggregatedText += parsed.content;
                await onEvent({ type: 'delta', text: parsed.content });
                continue;
              }
              if (parsed.type === 'result') {
                stats = parsed.stats;
              }
            } catch {
              // ignore malformed stream lines
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
        if (!rateLimited && rateLimitPattern.test(stderr)) {
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
            try {
              const parsed = JSON.parse(stdoutBuffer.trim()) as GeminiStreamEvent;
              if (parsed.type === 'result') {
                stats = parsed.stats;
              }
            } catch {
              // ignore trailing partial data
            }
          }

          if (signal || (code && code !== 0)) {
            if (rateLimited) {
              console.warn('[Gemini] streamChat fail-fast on upstream 429.');
              recordRuntimeIssue('gemini:rate-limit', new Error('streamChat upstream 429'));
              const rlResult = buildTextOnlyStructuredResult(
                'gemini',
                '⏳ Gemini 上游配額已達上限 (HTTP 429)，本次任務已快速中止以避免長時間退避重試。請稍後再試或錯開排程時間。'
              );
              if (!started) {
                await emitStart();
              }
              await onEvent({ type: 'done', text: rlResult.text });
              resolve(rlResult);
              return;
            }
            if (timedOut || signal === 'SIGTERM') {
              const timeoutResult = buildTextOnlyStructuredResult('gemini', '✨ 10分鐘內未完成');
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
                provider: 'gemini',
                text: aggregatedText,
                ...(sessionId ? { sessionId } : {}),
                ...(stats !== undefined ? { stats } : {})
              });
              return;
            }

            const message = `Error calling Gemini: exit=${code || 0}${signal ? ` signal=${signal}` : ''} stderr=${stderr}`;
            const fields: { code?: string | number; signal?: string; stderr?: string } = { stderr };
            if (code !== null && code !== undefined) {
              fields.code = code;
            }
            if (signal) {
              fields.signal = signal;
            }
            reject(new ProcessError(message, fields));
            return;
          }

          if (!aggregatedText.trim()) {
            const fallback = await this.chatStructured(prompt, options);
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
            provider: 'gemini',
            text: aggregatedText,
            ...(sessionId ? { sessionId } : {}),
            ...(stats !== undefined ? { stats } : {})
          });
        })().catch((error) => {
          reject(error);
        });
      });

      child.stdin?.end();
    });
  }

  /**
   * 呼叫系統的 gemini-cli 處理訊息
   * @param prompt 使用者的輸入
   * @param options 選項，可指定 model
   * @returns Gemini 的回應文字
   */
  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    const result = await this.chatStructured(prompt, options);
    return result.text;
  }
}
