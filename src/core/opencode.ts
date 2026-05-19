import type { AIAgentOptions } from './agent.js';
import {
  buildTextOnlyStructuredResult,
  type AgentStructuredResult
} from './agent-result.js';
import { ProcessError, runProcess } from './process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { CliAgentBase, type CliAgentConfig, type CliStreamParse } from './cli-agent-base.js';

type OpencodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    text?: string;
    tokens?: unknown;
    cost?: unknown;
    reason?: unknown;
  };
};

export function parseOpencodeJsonOutput(stdout: string): AgentStructuredResult | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const events: unknown[] = [];
  const textParts: string[] = [];
  let sawJson = false;
  let stats: Record<string, unknown> | undefined;

  for (const line of lines) {
    if (!line.startsWith('{')) {
      return null;
    }

    try {
      const parsed = JSON.parse(line) as OpencodeEvent;
      sawJson = true;
      events.push(parsed);

      if (parsed.type === 'text' && typeof parsed.part?.text === 'string') {
        textParts.push(parsed.part.text);
      }

      if (parsed.type === 'step_finish' && parsed.part) {
        const nextStats: Record<string, unknown> = {};
        if (parsed.part.tokens !== undefined) {
          nextStats.tokens = parsed.part.tokens;
        }
        if (parsed.part.cost !== undefined) {
          nextStats.cost = parsed.part.cost;
        }
        if (parsed.part.reason !== undefined) {
          nextStats.reason = parsed.part.reason;
        }
        if (Object.keys(nextStats).length > 0) {
          stats = nextStats;
        }
      }
    } catch {
      return null;
    }
  }

  if (!sawJson) {
    return null;
  }

  const text = textParts.join('').trim();
  if (!text) {
    return null;
  }

  const result: AgentStructuredResult = {
    provider: 'opencode',
    text,
    raw: events,
    events
  };
  if (stats) {
    result.stats = stats;
  }
  return result;
}

const OPENCODE_RATE_LIMIT_PATTERN = /\b429\b|Too Many Requests|RESOURCE_EXHAUSTED/i;
const OPENCODE_RATE_LIMIT_MESSAGE =
  '⏳ Opencode 上游配額已達上限 (HTTP 429)，本次任務已快速中止以避免長時間退避重試。請稍後再試或錯開排程時間。';
const OPENCODE_TIMEOUT_MESSAGE = '✨ 10分鐘內未完成';

export class OpencodeAgent extends CliAgentBase {
  protected readonly config: CliAgentConfig = {
    provider: 'opencode',
    binary: 'opencode',
    rateLimitPattern: OPENCODE_RATE_LIMIT_PATTERN,
    rateLimitMessage: OPENCODE_RATE_LIMIT_MESSAGE,
    timeoutMessage: OPENCODE_TIMEOUT_MESSAGE
  };

  protected override getCwd(): string {
    return this.getWorkspacePath();
  }

  protected parseStreamLine(line: string): CliStreamParse | null {
    if (!line.startsWith('{')) {
      return null;
    }
    try {
      const parsed = JSON.parse(line) as OpencodeEvent;
      const result: CliStreamParse = {};
      if (typeof parsed.sessionID === 'string' && parsed.sessionID.trim().length > 0) {
        result.sessionId = parsed.sessionID;
      }
      if (parsed.type === 'step_start') {
        result.emitStart = true;
      }
      if (parsed.type === 'text' && typeof parsed.part?.text === 'string') {
        result.deltaText = parsed.part.text;
      }
      if (parsed.type === 'step_finish' && parsed.part) {
        const nextStats: Record<string, unknown> = {};
        if (parsed.part.tokens !== undefined) {
          nextStats.tokens = parsed.part.tokens;
        }
        if (parsed.part.cost !== undefined) {
          nextStats.cost = parsed.part.cost;
        }
        if (parsed.part.reason !== undefined) {
          nextStats.reason = parsed.part.reason;
        }
        if (Object.keys(nextStats).length > 0) {
          result.stats = nextStats;
        }
      }
      return result;
    } catch {
      return null;
    }
  }

  private isVerboseStderrEnabled(): boolean {
    const raw = (process.env.OPENCODE_VERBOSE_STDERR || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  }

  private summarizeStderr(stderr: string): string {
    const firstLine = stderr
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine || '(empty line)';
  }

  private hasErrorLikeStderr(stderr: string): boolean {
    return /(error|fatal|exception|traceback|failed|denied)/i.test(stderr);
  }

  private logStderr(scope: string, stderr: string): void {
    if (!stderr || stderr.trim().length === 0) {
      return;
    }

    const verbose = this.isVerboseStderrEnabled();
    const errorLike = this.hasErrorLikeStderr(stderr);
    if (verbose || errorLike) {
      console.log(
        `[Opencode ${scope}] stderr (len=${stderr.length}):\n${stderr.substring(0, 2000)}`
      );
      return;
    }

    console.log(
      `[Opencode ${scope}] stderr summary: ${this.summarizeStderr(stderr)} (len=${stderr.length})`
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

    // 3. 移除 opencode 啟動 banner 行 (e.g. "> build · model/name")
    cleaned = cleaned.replace(/^\s*>\s*build\s*·.*$/gim, '');

    return cleaned.trim();
  }

  protected buildChatArgs(options?: AIAgentOptions, format: 'json' | null = 'json'): string[] {
    const forceNewSession = options?.forceNewSession === true;
    const isPassthrough = options?.isPassthroughCommand === true;
    const args = ['run'];
    if (!forceNewSession) {
      args.push('-c');
    }
    if (!isPassthrough && format) {
      args.push('--format', format);
    }
    if (options?.model) {
      args.push('--model', options.model);
    }
    return args;
  }

  private getWorkspacePath(): string {
    return process.env.GEMINI_PROJECT_DIR
      ? `${process.env.GEMINI_PROJECT_DIR}/workspace`
      : 'workspace';
  }

  private async executeChatProcess(
    prompt: string,
    options?: AIAgentOptions
  ): Promise<{ stdout: string; stderr: string }> {
    const isPassthrough = options?.isPassthroughCommand === true;
    const args = this.buildChatArgs(options, 'json');
    if (isPassthrough) {
      console.log('[Opencode] Passthrough command detected, sending raw command to CLI.');
    }
    if (options?.model) {
      console.log(`[Opencode] Executing with model: ${options.model}`);
    } else {
      console.log(`[Opencode] Executing (default model)`);
    }

    const workspacePath = this.getWorkspacePath();
    const argsWithPrompt = [...args, prompt];
    console.log(`[Opencode] Command: opencode ${args.join(' ')} <prompt>`);
    console.log(`[Opencode] Working directory: ${workspacePath}`);
    console.log(`[Opencode] Starting execution...`);

    return runProcess('opencode', argsWithPrompt, {
      timeoutMs: 1800000,
      cwd: workspacePath,
      env: {
        ...process.env
      },
      abortOnStderr: {
        pattern: /\b429\b|Too Many Requests|RESOURCE_EXHAUSTED/i,
        code: 'ERATELIMIT',
        message: 'Opencode upstream rate-limited (HTTP 429); aborted before internal backoff retries.'
      }
    });
  }

  private toStructuredResult(stdout: string, options?: AIAgentOptions): AgentStructuredResult {
    if (options?.isPassthroughCommand !== true) {
      const structured = parseOpencodeJsonOutput(stdout);
      if (structured) {
        structured.text = this.cleanOutput(structured.text);
        return structured;
      }
      // stdout 是 Opencode JSON events 格式但沒有文字事件 (e.g. 只有 step_start)
      // 此時不應把原始 JSON 當作回應內容回傳
      if (stdout.trimStart().startsWith('{')) {
        return buildTextOnlyStructuredResult(
          'opencode',
          'Opencode 執行完成,但沒有返回任何文字內容。',
          { raw: stdout }
        );
      }
    }

    const cleaned = this.cleanOutput(stdout);
    return buildTextOnlyStructuredResult(
      'opencode',
      cleaned || 'Opencode 執行完成,但沒有返回任何文字內容。',
      { raw: stdout }
    );
  }

  /**
   * 生成結構化摘要
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

      const args = ['run'];

      // 若有指定 model，加入參數
      if (options?.model) {
        args.push('--model', options.model);
      }

      console.log(`[Opencode Summarize] Starting...`);
      const { stdout, stderr } = await runProcess('opencode', [...args, prompt]);

      this.logStderr('Summarize', stderr);

      const cleaned = this.cleanOutput(stdout);

      // 驗證摘要長度，過長則截斷
      if (cleaned.length > 280) {
        return cleaned.substring(0, 280) + '...';
      }

      return cleaned || '(摘要失敗)';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Opencode] Summarization failed:', message);
      // Fallback: 截斷原文
      return text.substring(0, 200) + '...';
    }
  }

  async chatStructured(prompt: string, options?: AIAgentOptions): Promise<AgentStructuredResult> {
    try {
      const { stdout, stderr } = await this.executeChatProcess(prompt, options);

      console.log(`[Opencode] Execution completed. Output length: ${stdout.length}`);
      this.logStderr('Chat', stderr);

      const structured = this.toStructuredResult(stdout, options);
      if (!structured.text || structured.text.length === 0) {
        console.warn('[Opencode] Warning: No output after parsing/cleaning');
        console.log(`[Opencode] Raw stdout:\n${stdout.substring(0, 500)}...`);
        return buildTextOnlyStructuredResult(
          'opencode',
          'Opencode 執行完成,但沒有返回任何文字內容。'
        );
      }

      console.log(`[Opencode] Reply length: ${structured.text.length}`);
      return structured;
    } catch (error: unknown) {
      const isProcessError = error instanceof ProcessError;
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      console.error('[Opencode] Execution failed:');
      console.error(`  Message: ${message}`);
      console.error(`  Code: ${isProcessError ? error.code : undefined}`);
      console.error(`  Signal: ${isProcessError ? error.signal : undefined}`);
      console.error(`  Stack: ${stack}`);

      if (isProcessError && error.stdout) {
        console.error(`  Stdout: ${error.stdout.substring(0, 500)}`);
      }
      if (isProcessError && error.stderr) {
        console.error(`  Stderr: ${error.stderr.substring(0, 500)}`);
      }

      if (isProcessError && error.code === 'ERATELIMIT') {
        console.warn('[Opencode] Fail-fast on upstream 429 (rate limit).');
        recordRuntimeIssue('opencode:rate-limit', error);
        return buildTextOnlyStructuredResult(
          'opencode',
          '⏳ Opencode 上游配額已達上限 (HTTP 429)，本次任務已快速中止以避免長時間退避重試。請稍後再試或錯開排程時間。'
        );
      }

      if (isProcessError && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')) {
        return buildTextOnlyStructuredResult('opencode', '✨ 10分鐘內未完成');
      }

      const fields: { code?: string | number; signal?: string; stderr?: string; stdout?: string } =
        {
          stderr: isProcessError ? error.stderr || '' : '',
          stdout: isProcessError ? error.stdout || '' : ''
        };
      if (isProcessError && error.code !== undefined) fields.code = error.code;
      if (isProcessError && error.signal !== undefined) fields.signal = error.signal;
      throw new ProcessError(`Error calling Opencode: ${message}`, fields);
    }
  }

}
