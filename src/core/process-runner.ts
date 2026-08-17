/**
 * 共用子程序執行器
 */
import { spawn, type ChildProcess } from 'child_process';

/**
 * SIGTERM 之後等多久仍未退場就升級成 SIGKILL。
 * Opencode 收到 SIGTERM 需要一點時間收尾,但 headless Chrome 整棵樹經常賴著不走
 * (實測 agent-browser + 12 個 chrome + 2 個 crashpad 在無工作狀態存活 2 小時以上)。
 */
const KILL_ESCALATION_MS = 5000;

/** Windows 沒有 POSIX process group 語意,只有這裡是 true 時才會用負數 PID。 */
const GROUP_KILL_SUPPORTED = process.platform !== 'win32';

/**
 * 終止整個 process group,而不是只終止直接 child。
 *
 * ⚠️ 負數 PID 是本函式的核心,也是整個檔案最大的地雷:`process.kill(-pid, sig)` 送的是
 * 「process group」,只有在 spawn 帶 `detached: true` 讓 child 成為 group leader 時,那一群
 * 才會是它自己的子孫。若 detached 沒生效,-pid 可能命中本行程所在的 group —— 也就是把
 * runner 自己連同所有進行中的工作一起殺掉。下面三道防護一道都不能拿掉:
 *
 *   1. pid 必須是正整數(spawn 失敗時 `child.pid` 是 undefined,`-undefined` 會變成 NaN)
 *   2. 只有 `GROUP_KILL_SUPPORTED` 才走負數;否則退回只殺直接 child
 *   3. 全程 try/catch —— 程序已結束時的 ESRCH 是正常情況,不是錯誤
 *
 * 升級不檢查 `child.exitCode`:直接 child 先退場、descendants 仍存活正是我們要修的情境,
 * 用 exitCode 當閘門會剛好在該殺的時候跳過。代價是 group 已清空時多送一次必然 ESRCH 的
 * 訊號(無害),以及 5 秒內 PID 被重用的理論風險(遠小於放著整棵 Chrome 不管)。
 */
export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;

  const send = (sig: NodeJS.Signals): void => {
    if (GROUP_KILL_SUPPORTED) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        // group 不存在或不是 group leader —— 退回只殺直接 child。
      }
    }
    try {
      child.kill(sig);
    } catch {
      // 程序已經不在了。
    }
  };

  send('SIGTERM');

  const escalation = setTimeout(() => send('SIGKILL'), KILL_ESCALATION_MS);
  // 不能讓這個 timer 拖住 event loop:主程式該退出時就該退出。
  escalation.unref?.();
}

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

/** 目前存活的子程序。detached 之後它們不再隨父行程的 group 收訊,必須自己記帳。 */
const liveChildren = new Set<ChildProcess>();

/**
 * 把 child 納入 shutdown 清理範圍。spawn 之後就要呼叫。
 *
 * detached 帶來的副作用:子程序脫離父行程的 process group,終端機的 Ctrl-C(SIGINT 送給
 * 整個前景 group)不再傳得到它。Docker 不受影響(docker stop 只送 SIGTERM 給 PID 1,
 * 本來就不靠 group),但本機 `npm run dev` 按 Ctrl-C 會留下 opencode 與 Chrome ——
 * 正好是這批修正要消滅的那種殘留。這張登記表就是補回那條路徑。
 */
export function trackChildProcess(child: ChildProcess): void {
  liveChildren.add(child);
  const forget = (): void => {
    liveChildren.delete(child);
  };
  child.once('close', forget);
  child.once('error', forget);
}

/**
 * 終止所有仍存活的子程序 group,回傳處理筆數。
 *
 * 由各服務**既有的**關閉流程呼叫(main.ts 的 SIGINT/SIGTERM handler、runner.ts 的
 * shutdown)。刻意不在這裡自己註冊 signal listener:main.ts 已經有一組會 process.exit(0)
 * 的 handler,再加一個會依註冊順序搶在優雅關閉之前退出 —— 而本模組被 import 得更早。
 */
export function terminateAllChildren(): number {
  const children = [...liveChildren];
  for (const child of children) terminateProcessTree(child);
  return children.length;
}

// 最後一道網:走到 exit 時已經沒有機會等待或升級,所以直接 SIGKILL。
// 正常路徑上 terminateAllChildren() 已經先送過 SIGTERM,這裡收的是漏網的。
// 只能做同步工作 —— 訊號送出是同步的,setTimeout 在這個階段不會再跑。
process.on('exit', () => {
  for (const child of liveChildren) {
    const pid = child.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    try {
      if (GROUP_KILL_SUPPORTED) process.kill(-pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // 已經不在了。
    }
  }
});

export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // 讓 child 自成 process group leader,terminateProcessTree() 才殺得到它的子孫
      // (Opencode 會再長出 agent-browser 與整棵 Chrome)。這裡刻意不 unref():
      // 我們仍要等這個 child 的 close 事件,detached 只影響訊號分群,不影響 await。
      detached: GROUP_KILL_SUPPORTED
    });
    trackChildProcess(child);

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
          terminateProcessTree(child);
          settle(() => reject(new ProcessError('Process timed out', { code: 'ETIMEDOUT', stdout, stderr })));
        }, options.timeoutMs)
      : null;

    const onAbort = () => {
      terminateProcessTree(child);
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
        terminateProcessTree(child);
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
