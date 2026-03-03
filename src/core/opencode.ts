import type { AIAgent, AIAgentOptions } from './agent.js';
import { ProcessError, runProcess } from './process-runner.js';

export class OpencodeAgent implements AIAgent {
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

  /**
   * 生成結構化摘要
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

      const args = ['run'];

      // 若有指定 model，加入參數
      if (options?.model) {
        args.push('--model', options.model);
      }

      console.log(`[Opencode Summarize] Starting...`);
      const { stdout, stderr } = await runProcess('opencode', args, { stdin: prompt });

      if (stderr && stderr.trim().length > 0) {
        console.log(`[Opencode Summarize] stderr: ${stderr.substring(0, 200)}`);
      }

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

  /**
   * 呼叫 opencode run 處理訊息
   */
  async chat(prompt: string, options?: AIAgentOptions): Promise<string> {
    try {
      const isPassthrough = options?.isPassthroughCommand === true;
      const forceNewSession = options?.forceNewSession === true;
      if (isPassthrough) {
        console.log('[Opencode] Passthrough command detected, sending raw command to CLI.');
      }

      // 使用 echo 透過 stdin 傳遞訊息,比直接作為參數更快
      // 使用 -c 接續上次 session,減少重複注入記憶
      const args = ['run'];
      if (!forceNewSession) {
        args.push('-c');
      }

      // 若有指定 model,加入參數
      if (options?.model) {
        args.push('--model', options.model);
        console.log(`[Opencode] Executing with model: ${options.model}`);
      } else {
        console.log(`[Opencode] Executing (default model)`);
      }

      // 取得絕對工作目錄路徑
      const workspacePath = process.env.GEMINI_PROJECT_DIR
        ? `${process.env.GEMINI_PROJECT_DIR}/workspace`
        : 'workspace';

      console.log(`[Opencode] Command: opencode ${args.join(' ')}`);
      console.log(`[Opencode] Working directory: ${workspacePath}`);
      console.log(`[Opencode] Starting execution...`);

      // 設定 10 分鐘超時,並在 workspace/ 目錄執行
      const { stdout, stderr } = await runProcess('opencode', args, {
        timeoutMs: 600000,
        cwd: workspacePath,
        env: {
          ...process.env
        },
        stdin: prompt
      });

      console.log(`[Opencode] Execution completed. Output length: ${stdout.length}`);

      // 顯示完整 stderr 以便 debug
      if (stderr && stderr.trim().length > 0) {
        console.log(`[Opencode] stderr:\n${stderr}`);
      }

      const cleaned = this.cleanOutput(stdout);

      if (!cleaned || cleaned.length === 0) {
        console.warn('[Opencode] Warning: No output after cleaning');
        console.log(`[Opencode] Raw stdout:\n${stdout.substring(0, 500)}...`);
        return 'Opencode 執行完成,但沒有返回任何文字內容。';
      }

      console.log(`[Opencode] Reply length: ${cleaned.length}`);
      return cleaned;
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

      if (isProcessError && (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM')) {
        return '✨ 10分鐘內未完成';
      }

      const fields: { code?: string | number; signal?: string; stderr?: string; stdout?: string } = {
        stderr: isProcessError ? (error.stderr || '') : '',
        stdout: isProcessError ? (error.stdout || '') : ''
      };
      if (isProcessError && error.code !== undefined) fields.code = error.code;
      if (isProcessError && error.signal !== undefined) fields.signal = error.signal;
      throw new ProcessError(`Error calling Opencode: ${message}`, fields);
    }
  }
}
