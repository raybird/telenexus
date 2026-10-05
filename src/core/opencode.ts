import fs from 'node:fs';
import path from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import type { AIAgentOptions } from './agent.js';
import { buildTextOnlyStructuredResult, type AgentStructuredResult } from './agent-result.js';
import { ProcessError, runProcess } from './process-runner.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { CliAgentBase, type CliAgentConfig, type CliStreamParse } from './cli-agent-base.js';
import { getOpencodeTaskTimeoutMs } from '../config/timeouts.js';
import {
  UPSTREAM_RATE_LIMIT_PATTERN,
  hasUpstreamModelInvalid,
  type UpstreamError
} from './rate-limit.js';
import { resolveProjectDir } from '../utils/paths.js';
import { createLogger } from './logger.js';
import { emitEvent } from '../services/event-bus.js';
import {
  findUpstreamError,
  interpretEvent,
  parseEventLine,
  type OpencodeEvent
} from './opencode-event-parser.js';

const logger = createLogger('Opencode');

export function parseOpencodeJsonOutput(stdout: string): AgentStructuredResult | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const events: OpencodeEvent[] = [];
  const textParts: string[] = [];
  let stats: Record<string, unknown> | undefined;

  for (const line of lines) {
    const event = parseEventLine(line);
    if (!event) {
      // 整段 stdout 必須全部是 JSON event；遇到非 JSON 行直接放棄
      return null;
    }
    events.push(event);

    const interpreted = interpretEvent(event);
    if (interpreted.text) {
      textParts.push(interpreted.text);
    }
    if (interpreted.stats) {
      stats = interpreted.stats;
    }
  }

  if (events.length === 0) {
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

/**
 * 讓 opencode 把內部錯誤吐到 stderr —— 這是 429 fail-fast 能不能生效的前提。
 *
 * opencode 預設只把上游錯誤寫進 `~/.local/share/opencode/log/*.log`,stderr 全程一個字
 * 都沒有;而 `--format json` 又是跑完才吐 stdout,所以卡住時 stdout 也是 0 bytes。
 * 於是 `abortOnStderr` 永遠比對不到東西,遇到 429 就一路指數退避(8s→16s→…→512s)
 * 直到撞上 OPENCODE_TASK_TIMEOUT_MS。
 *
 * 2026-08-25 正式環境正是如此:上游持續 429,每一發排程都燒滿 30 分鐘才失敗,連燒四天,
 * 而 fail-fast 機制其實 v2.12.0 就在了。加上這兩個旗標後實測 1.1 秒即可攔下。
 *
 * `--log-level ERROR` 是必要的節流:預設 INFO 會把每次 bus publish 都印到 stderr。
 */
const OPENCODE_LOG_ARGS = ['--print-logs', '--log-level', 'ERROR'] as const;

/**
 * 429 快速中止設定。抽成共用常數是因為它先前被寫死在 executeChatProcess 裡,
 * 而 summarize 自己組 args、自己呼叫 runProcess,於是整條路徑既沒有 fail-fast
 * 也沒有 timeout —— runProcess 的 timeoutMs 是 optional,不給就真的不設計時器,
 * 一次上游限流就能讓摘要子行程無限期掛著。共用一份才不會再度漂移。
 */
const OPENCODE_RATE_LIMIT_ABORT = {
  pattern: UPSTREAM_RATE_LIMIT_PATTERN,
  code: 'ERATELIMIT',
  message: 'Opencode upstream rate-limited (HTTP 429); aborted before internal backoff retries.'
};

const OPENCODE_RATE_LIMIT_MESSAGE =
  '⏳ Opencode 上游配額已達上限 (HTTP 429)，本次任務已快速中止以避免長時間退避重試。請稍後再試或錯開排程時間。';
/**
 * 逾時訊息的分鐘數要跟實際 timeout 一致。
 *
 * 原本寫死「10分鐘」,但 `OPENCODE_TASK_TIMEOUT_MS` 預設是 1800000ms = 30 分鐘,
 * 正式環境也沒有覆寫 —— 使用者等滿 30 分鐘,卻被告知 10 分鐘沒完成。
 *
 * 改成動態不會弄壞排程重試偵測:`scheduler-helpers.ts` 比對的是
 * `/^✨\s*\d+\s*分鐘內未完成/`,`\d+` 容得下任何分鐘數。
 */
function buildTimeoutMessage(): string {
  return `✨ ${Math.round(getOpencodeTaskTimeoutMs() / 60_000)}分鐘內未完成`;
}

export class OpencodeAgent extends CliAgentBase {
  protected override getEnv(): NodeJS.ProcessEnv {
    const env = super.getEnv();
    const errors: ParseError[] = [];
    const config = parse(env.OPENCODE_CONFIG_CONTENT || '{}', errors, {
      allowTrailingComma: true
    }) as Record<string, unknown>;
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('OPENCODE_CONFIG_CONTENT 必須是有效的 JSON／JSONC 設定物件。');
    }
    const mcp = config.mcp ?? {};
    if (typeof mcp !== 'object' || Array.isArray(mcp)) {
      throw new Error('OPENCODE_CONFIG_CONTENT 的 mcp 必須是設定物件。');
    }
    if (Object.hasOwn(mcp, 'telenexus_browser')) {
      logger.warn('browser.custom-config-preserved', { builtinCleanup: false });
      return env;
    }
    config.mcp = {
      ...mcp,
      telenexus_browser: {
        type: 'local',
        command: [
          'setsid',
          'node',
          '/usr/local/lib/telenexus/browser-mcp-launcher.mjs',
          'node',
          '/usr/local/lib/telenexus/browser/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
          '--headless',
          '--isolated',
          '--slim',
          '--no-usage-statistics',
          '--no-performance-crux',
          '--executable-path=/opt/telenexus/chrome/chrome-linux64/chrome',
          '--chrome-arg=--no-sandbox',
          '--chrome-arg=--disable-dev-shm-usage'
        ],
        timeout: 20_000
      }
    };
    return {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      TELENEXUS_BROWSER_AUDIT_FILE: path.join(resolveProjectDir(), 'data', 'browser-lifecycle.jsonl')
    };
  }

  protected readonly config: CliAgentConfig = {
    provider: 'opencode',
    binary: 'opencode',
    // 與非串流的 abortOnStderr 共用同一個樣式。這裡原本自帶一份寬鬆的 `\b429\b`,
    // 它認不得 opencode 1.18 的 `Rate limit exceeded`,而且會被舊版回吐的 request body 誤觸。
    rateLimitPattern: UPSTREAM_RATE_LIMIT_PATTERN,
    rateLimitMessage: OPENCODE_RATE_LIMIT_MESSAGE,
    timeoutMessage: buildTimeoutMessage(),
    streamTimeoutMs: getOpencodeTaskTimeoutMs()
  };

  protected override getCwd(): string {
    return this.getWorkspacePath();
  }

  protected override getVerboseStdoutPath(): string | null {
    if (process.env.OPENCODE_VERBOSE_STDOUT !== 'true') {
      return null;
    }
    return path.resolve(resolveProjectDir(), 'workspace', 'context', 'opencode-last-run.jsonl');
  }

  private writeVerboseStdout(stdout: string): void {
    const verbosePath = this.getVerboseStdoutPath();
    if (!verbosePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(verbosePath), { recursive: true });
      fs.writeFileSync(verbosePath, stdout, 'utf8');
    } catch {
      // best-effort
    }
  }

  protected parseStreamLine(line: string): CliStreamParse | null {
    const event = parseEventLine(line);
    if (!event) {
      return null;
    }
    const interpreted = interpretEvent(event);
    const result: CliStreamParse = {};
    if (interpreted.sessionId) result.sessionId = interpreted.sessionId;
    if (interpreted.emitStart) result.emitStart = true;
    if (interpreted.statusText) result.statusText = interpreted.statusText;
    if (interpreted.reasoningText !== undefined) result.reasoningText = interpreted.reasoningText;
    if (interpreted.text !== undefined) result.deltaText = interpreted.text;
    if (interpreted.stats) result.stats = interpreted.stats;
    if (interpreted.upstreamError) result.upstreamError = interpreted.upstreamError;
    return result;
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
      logger.info('stderr', { scope, len: stderr.length, text: stderr.substring(0, 2000) });
      return;
    }

    logger.info('stderr_summary', {
      scope,
      summary: this.summarizeStderr(stderr),
      len: stderr.length
    });
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

    // 4. 移除洩漏的工具呼叫 XML 區塊（模型直接輸出 function call 語法）
    cleaned = cleaned.replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, '');
    cleaned = cleaned.replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, '');
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');

    // 5. 移除殘留的孤立結束標籤（如大量重複的 </function>）
    cleaned = cleaned.replace(/<\/(function|parameter|tool_call)[^>]*>/gi, '');

    // 6. 移除工具呼叫結果行，如 [{"result": "success"}]
    cleaned = cleaned.replace(/^\[{.*}\]\s*$/gm, '');

    const result = cleaned.trim();

    // 垃圾偵測：原文含大量 </function> 但清洗後幾乎沒內容，改回傳警示
    const leakCount = (text.match(/<\/function>/gi) ?? []).length;
    if (leakCount > 5 && result.length < 50) {
      logger.warn('tool_call_leak_detected', { leakCount, originalLen: text.length });
      return '（模型輸出了異常的工具呼叫格式，內容已略過）';
    }

    return result;
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
    // 一律加上:passthrough 指令同樣可能撞到上游 429,而 stderr 不參與輸出解析。
    args.push(...OPENCODE_LOG_ARGS);
    return args;
  }

  private getWorkspacePath(): string {
    return process.env.APP_PROJECT_DIR ? `${process.env.APP_PROJECT_DIR}/workspace` : 'workspace';
  }

  private async executeChatProcess(
    prompt: string,
    options?: AIAgentOptions
  ): Promise<{ stdout: string; stderr: string }> {
    const isPassthrough = options?.isPassthroughCommand === true;
    const args = this.buildChatArgs(options, 'json');
    if (isPassthrough) {
      logger.info('passthrough_detected');
    }
    logger.info('execute', { model: options?.model || 'default' });

    const workspacePath = this.getWorkspacePath();
    const argsWithPrompt = [...args, prompt];
    logger.info('start', { cmd: `opencode ${args.join(' ')} <prompt>`, cwd: workspacePath });
    emitEvent('opencode_start', { model: options?.model || 'default' });

    return runProcess('opencode', argsWithPrompt, {
      timeoutMs: getOpencodeTaskTimeoutMs(),
      cwd: workspacePath,
      env: this.getEnv(),
      abortOnStderr: OPENCODE_RATE_LIMIT_ABORT,
      ...(options?.signal ? { signal: options.signal } : {})
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
   * 回合結束事件。exit 0 不代表上游真的服務了這次請求:opencode 1.15 在上游錯誤時仍以
   * exit 0 收場。把這個訊號帶進事件裡,訂閱端(模型健康檢查的流量豁免)才不會把假成功
   * 當成「模型顯然活著」。`upstreamInvalid` 是 stderr 樣式的判定,保留給既有的事件讀者。
   */
  private emitDone(stdout: string, stderr: string, upstreamError: UpstreamError | null): void {
    emitEvent('opencode_done', {
      outputLen: stdout.length,
      upstreamInvalid: hasUpstreamModelInvalid(stderr),
      upstreamError: upstreamError !== null,
      ...(upstreamError?.statusCode !== undefined ? { statusCode: upstreamError.statusCode } : {})
    });
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
      args.push(...OPENCODE_LOG_ARGS);

      logger.info('summarize_start');
      // timeoutMs / abortOnStderr 缺一不可：runProcess 不給 timeoutMs 就不設計時器，
      // 摘要會在上游 429 時無限期掛著（chat 路徑至少還有 30 分鐘的保險絲）。
      const { stdout, stderr } = await runProcess('opencode', [...args, prompt], {
        timeoutMs: getOpencodeTaskTimeoutMs(),
        abortOnStderr: OPENCODE_RATE_LIMIT_ABORT
      });

      this.logStderr('Summarize', stderr);

      const cleaned = this.cleanOutput(stdout);

      // 驗證摘要長度，過長則截斷
      if (cleaned.length > 280) {
        return cleaned.substring(0, 280) + '...';
      }

      return cleaned || '(摘要失敗)';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('summarize_failed', { err: message });
      return text.substring(0, 200) + '...';
    }
  }

  async chatStructured(prompt: string, options?: AIAgentOptions): Promise<AgentStructuredResult> {
    try {
      return await this.runChatStructured(prompt, options);
    } finally {
      await this.onRunFinished(options);
    }
  }

  private async runChatStructured(
    prompt: string,
    options?: AIAgentOptions
  ): Promise<AgentStructuredResult> {
    try {
      const { stdout, stderr } = await this.executeChatProcess(prompt, options);
      this.writeVerboseStdout(stdout);

      // passthrough 指令不帶 `--format json`,stdout 是給使用者的純文字,不當成事件解析。
      const upstream = options?.isPassthroughCommand === true ? null : findUpstreamError(stdout);

      logger.info('done', { outputLen: stdout.length });
      this.emitDone(stdout, stderr, upstream?.upstreamError ?? null);
      this.logStderr('Chat', stderr);
      if (upstream) {
        return this.buildUpstreamErrorResult(upstream.upstreamError, upstream);
      }

      const structured = this.toStructuredResult(stdout, options);
      if (!structured.text || structured.text.length === 0) {
        logger.warn('no_output', { rawStdout: stdout.substring(0, 500) });
        return buildTextOnlyStructuredResult(
          'opencode',
          'Opencode 執行完成,但沒有返回任何文字內容。'
        );
      }

      logger.info('reply', { len: structured.text.length });
      return structured;
    } catch (error: unknown) {
      const isProcessError = error instanceof ProcessError;
      const message = error instanceof Error ? error.message : String(error);
      logger.error('execution_failed', {
        err: message,
        code: isProcessError ? String(error.code) : undefined,
        signal: isProcessError ? error.signal : undefined,
        stdout: isProcessError && error.stdout ? error.stdout.substring(0, 500) : undefined,
        stderr: isProcessError && error.stderr ? error.stderr.substring(0, 500) : undefined
      });

      if (isProcessError && error.code === 'EABORTED') {
        return buildTextOnlyStructuredResult('opencode', '⏹️ 任務已被使用者中止。');
      }

      if (isProcessError && error.code === 'ERATELIMIT') {
        logger.warn('rate_limit');
        recordRuntimeIssue('opencode:rate-limit', error);
        return buildTextOnlyStructuredResult('opencode', OPENCODE_RATE_LIMIT_MESSAGE, {
          failure: { kind: 'rate-limit', message }
        });
      }

      if (isProcessError && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')) {
        return buildTextOnlyStructuredResult('opencode', buildTimeoutMessage(), {
          failure: { kind: 'timeout', message }
        });
      }

      // opencode 1.18 起上游錯誤以 exit 1 結束,error 事件仍在 stdout。有事件就是上游錯誤,
      // 不是「opencode 自己壞了」:照樣回結構化失敗,別讓它變成一句通用的執行失敗。
      // 沒有事件時不發 opencode_done:那是 opencode 自己失敗,不能留下一筆看起來像成功的紀錄。
      if (isProcessError && typeof error.code === 'number' && !options?.isPassthroughCommand) {
        const failedStdout = error.stdout || '';
        const upstream = findUpstreamError(failedStdout);
        if (upstream) {
          this.emitDone(failedStdout, error.stderr || '', upstream.upstreamError);
          return this.buildUpstreamErrorResult(upstream.upstreamError, upstream);
        }
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
