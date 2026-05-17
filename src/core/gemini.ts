import type { AIAgentOptions } from './agent.js';
import {
  buildTextOnlyStructuredResult,
  type AgentStructuredResult
} from './agent-result.js';
import { ProcessError, runProcess } from './process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { CliAgentBase, type CliAgentConfig, type CliStreamParse } from './cli-agent-base.js';

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

const GEMINI_RATE_LIMIT_PATTERN = /(status|code)\s*[:=]?\s*429|RESOURCE_EXHAUSTED/i;
const GEMINI_RATE_LIMIT_MESSAGE =
  '⏳ Gemini 上游配額已達上限 (HTTP 429)，本次任務已快速中止以避免長時間退避重試。請稍後再試或錯開排程時間。';
const GEMINI_TIMEOUT_MESSAGE = '✨ 10分鐘內未完成';

export class GeminiAgent extends CliAgentBase {
  protected readonly config: CliAgentConfig = {
    provider: 'gemini',
    binary: 'gemini',
    rateLimitPattern: GEMINI_RATE_LIMIT_PATTERN,
    rateLimitMessage: GEMINI_RATE_LIMIT_MESSAGE,
    timeoutMessage: GEMINI_TIMEOUT_MESSAGE
  };

  protected override getEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR || process.cwd(),
      GEMINI_BYPASS_MEMORY_HOOK: '1'
    };
  }

  protected parseStreamLine(line: string): CliStreamParse | null {
    try {
      const parsed = JSON.parse(line) as GeminiStreamEvent;
      const result: CliStreamParse = {};
      if (parsed.type === 'init') {
        if (typeof parsed.session_id === 'string' && parsed.session_id.trim().length > 0) {
          result.sessionId = parsed.session_id;
        }
        result.emitStart = true;
        return result;
      }
      if (
        parsed.type === 'message' &&
        parsed.role === 'assistant' &&
        typeof parsed.content === 'string'
      ) {
        result.deltaText = parsed.content;
        return result;
      }
      if (parsed.type === 'result') {
        result.stats = (parsed.stats as Record<string, unknown>) || undefined;
        return result;
      }
      return null;
    } catch {
      return null;
    }
  }

  protected override buildChatArgs(options?: AIAgentOptions): string[] {
    return this.buildArgsCore(options, 'stream-json');
  }

  private buildArgsCore(
    options: AIAgentOptions | undefined,
    outputFormat: 'json' | 'stream-json' | null
  ): string[] {
    const isPassthrough = options?.isPassthroughCommand === true;
    const forceNewSession = options?.forceNewSession === true;
    const args = ['--yolo'];
    if (!forceNewSession) {
      args.push('-r');
    }
    if (!isPassthrough && outputFormat) {
      args.push('--output-format', outputFormat);
    }
    if (options?.model) {
      args.push('--model', options.model);
    }
    // -p 放最後一個 flag，prompt 由呼叫端以位置參數附加在尾端
    args.push('-p');
    return args;
  }

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
  protected cleanOutput(text: string): string {
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

  private async executeChatProcess(
    prompt: string,
    options?: AIAgentOptions
  ): Promise<{ stdout: string; stderr: string }> {
    const isPassthrough = options?.isPassthroughCommand === true;
    const args = this.buildArgsCore(options, 'json');
    const argsWithPrompt = [...args, prompt];

    if (isPassthrough) {
      console.log(`[Gemini] isPassthroughCommand: true`);
      console.log(`[Gemini] Original prompt: ${prompt}`);
      console.log(
        `[Gemini] Executing passthrough via -p only: gemini ${args.join(' ')} <prompt> (hook bypass)`
      );
    } else if (options?.model) {
      console.log(`[Gemini] Executing (YOLO Mode) with model: ${options.model}`);
    } else {
      console.log(`[Gemini] Executing (YOLO Mode): gemini ${args.join(' ')} <prompt>`);
    }

    return runProcess('gemini', argsWithPrompt, {
      timeoutMs: 660000,
      cwd: 'workspace',
      env: this.getEnv(),
      abortOnStderr: {
        pattern: GEMINI_RATE_LIMIT_PATTERN,
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

}

