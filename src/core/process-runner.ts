/**
 * 共用子程序執行器
 */
import { spawn } from 'child_process';

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  /**
   * 當 stderr 累積內容首次命中 pattern 時，立即 SIGTERM 子程序並以指定 code/message 拒絕。
   * 用於 fail-fast：例如偵測到上游 429 後不再等待內部退避重試。
   */
  abortOnStderr?: { pattern: RegExp; code: string; message: string };
  signal?: AbortSignal;
};

export class ProcessError extends Error {
  code: string | number | undefined;
  signal: string | undefined;
  stdout: string | undefined;
  stderr: string | undefined;

  constructor(
    message: string,
    fields?: { code?: string | number; signal?: string; stdout?: string; stderr?: string }
  ) {
    super(message);
    this.name = 'ProcessError';
    this.code = fields?.code;
    this.signal = fields?.signal;
    this.stdout = fields?.stdout;
    this.stderr = fields?.stderr;
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          settle(() => reject(new ProcessError('Process timed out', { code: 'ETIMEDOUT', stdout, stderr })));
        }, options.timeoutMs)
      : null;

    const onAbort = () => {
      child.kill('SIGTERM');
      settle(() => reject(new ProcessError('Process aborted by signal', { code: 'EABORTED', stdout, stderr })));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (!settled && options.abortOnStderr && options.abortOnStderr.pattern.test(stderr)) {
        child.kill('SIGTERM');
        settle(() => reject(new ProcessError(options.abortOnStderr!.message, { code: options.abortOnStderr!.code, stdout, stderr })));
      }
    });

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('close', (code, signal) => {
      settle(() => {
        if (signal) {
          reject(new ProcessError(`Process terminated with signal ${signal}`, { signal, stdout, stderr }));
          return;
        }
        if (code && code !== 0) {
          reject(new ProcessError(`Process exited with code ${code}`, { code, stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    if (options.stdin && child.stdin) child.stdin.write(options.stdin);
    child.stdin?.end();
  });
}
