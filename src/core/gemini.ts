import type { AIAgent, AIAgentOptions } from './agent.js';
import { ProcessError, runProcess } from './process-runner.js';

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

  /**
   * 生成結構化摘要
   * 格式固定為 Goal/Decision/Todo/Facts 欄位
   */
  async summarize(text: string, options?: AIAgentOptions): Promise<string> {
    try {
      const prompt = `請將以下內容整理成結構化摘要，使用以下格式（省略空白欄位）：

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

  /**
   * 呼叫系統的 gemini-cli 處理訊息
   * @param prompt 使用者的輸入
   * @param options 選項，可指定 model
   * @returns Gemini 的回應文字
   */
  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    try {
      // 判斷是否為 passthrough 指令（如 /compress, /compact）
      const isPassthrough = options?.isPassthroughCommand === true;
      const forceNewSession = options?.forceNewSession === true;

      let stdout: string;
      let stderr: string;

      if (isPassthrough) {
        // Passthrough 指令：僅透過 -p 傳遞，避免與 stdin 重複送入相同指令
        console.log(`[Gemini] isPassthroughCommand: true`);
        console.log(`[Gemini] Original prompt: ${prompt}`);
        const args = ['--yolo'];
        if (!forceNewSession) {
          args.push('-r');
        }
        args.push('-p', prompt);

        if (options?.model) {
          args.push('--model', options.model);
        }

        console.log(
          `[Gemini] Executing passthrough via -p only: gemini ${args.join(' ')} (hook bypass)`
        );

        const result = await runProcess('gemini', args, {
          timeoutMs: 600000,
          // 保持在 workspace，確保 session 一致；僅略過記憶 hook
          cwd: 'workspace',
          env: {
            ...process.env,
            GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR || process.cwd(),
            GEMINI_BYPASS_MEMORY_HOOK: '1'
          }
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        // 一般對話：使用陣列參數傳遞
        // 開啟 --yolo 模式，允許自動執行所有工具 (搜尋、讀取檔案、執行指令等)
        // 使用 -p 進入非互動模式
        // 使用 --resume 接續上次 session，減少重複注入記憶
        const args = ['--yolo'];
        if (!forceNewSession) {
          args.push('-r');
        }
        args.push('-p', prompt);

        // 若有指定 model，加入參數
        if (options?.model) {
          args.push('--model', options.model);
          console.log(`[Gemini] Executing (YOLO Mode) with model: ${options.model}`);
        } else {
          console.log(`[Gemini] Executing (YOLO Mode): gemini ${args.join(' ')} ...`);
        }

        // 設定 10 分鐘超時，並在 workspace/ 目錄執行，避免意外修改源碼
        const result = await runProcess('gemini', args, {
          timeoutMs: 600000,
          cwd: 'workspace',
          env: {
            ...process.env,
            GEMINI_PROJECT_DIR: process.env.GEMINI_PROJECT_DIR || process.cwd(),
            GEMINI_BYPASS_MEMORY_HOOK: '1'
          }
        });
        stdout = result.stdout;
        stderr = result.stderr;
      }

      if (stderr && stderr.trim().length > 0) {
        // 工具執行的過程通常會輸出很多 stderr 資訊，這裡我們記錄下來但不中斷流程
        console.log(`[Gemini-Tools] Log: ${stderr}`);
      }

      // 使用統一的清洗器
      const cleaned = this.cleanOutput(stdout);

      return cleaned || 'Gemini 執行完成，但沒有返回任何文字內容。';
    } catch (error: unknown) {
      console.error('[Gemini] Execution failed:', error);
      const recovered = this.recoverOutputFromError(error);
      if (recovered) {
        console.warn('[Gemini] Returning recovered stdout despite non-zero exit/signal.');
        return recovered;
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
        return this.chat(prompt, {
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

          await this.chat('/compress', {
            ...compressOptions
          });

          const recovered = await this.chat(prompt, {
            ...options,
            isPassthroughCommand: false,
            forceNewSession: false,
            autoCompressAttempted: true
          });

          if (autoRecoveryNotice) {
            return `⚠️ 偵測到 Gemini Session 壓縮異常，已自動執行 /compress 並恢復對話。\n\n${recovered}`;
          }
          return recovered;
        } catch (recoveryError) {
          console.error('[Gemini] Auto /compress recovery failed:', recoveryError);
        }
      }

      if (
        error instanceof ProcessError &&
        (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')
      ) {
        return '✨ 10分鐘內未完成';
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
