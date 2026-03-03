/**
 * 共用子程序執行器
 */
import { spawn } from 'child_process';

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
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
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new ProcessError('Process timed out', { code: 'ETIMEDOUT' }));
        }, options.timeoutMs)
      : null;

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (signal) {
        reject(
          new ProcessError(`Process terminated with signal ${signal}`, {
            signal,
            stdout,
            stderr
          })
        );
        return;
      }
      if (code && code !== 0) {
        reject(
          new ProcessError(`Process exited with code ${code}`, {
            code,
            stdout,
            stderr
          })
        );
        return;
      }
      resolve({ stdout, stderr });
    });

    if (options.stdin && child.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin?.end();
  });
}
