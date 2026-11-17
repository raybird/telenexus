import { spawn, type ChildProcess } from 'node:child_process';

/**
 * issue 0030：按需啟停 cloudflared Quick Tunnel（SCN-001、SCN-005）。
 *
 * - 啟動：以參數陣列執行 `cloudflared tunnel --no-autoupdate --url <固定目標>`（不經 shell），
 *   從輸出取得 trycloudflare.com 網址，外部健康檢查通過才算就緒；逾時或失敗就收掉子程序，不給網址。
 * - 並行的啟動請求共用同一次啟動；就緒後再要求直接沿用。
 * - 停止或 cloudflared 意外結束時清掉網址。`generation` 在進入或離開就緒時遞增，
 *   telenexus 以它判斷已發布的入口是否還有效。
 * - 閒置關閉不在這裡：只有 telenexus 知道面板有沒有人在用（見 issue 0030 implementation-plan）。
 */

export type TunnelStatus = 'stopped' | 'starting' | 'ready' | 'failed';

export type TunnelState = {
  status: TunnelStatus;
  generation: number;
  url?: string;
  error?: string;
};

export type TunnelManagerOptions = {
  cloudflaredBin: string;
  /** 固定的轉送目標（Compose 內 telenexus 的面板連接埠），不接受外部指定。 */
  targetUrl: string;
  /** 經公開網址打到面板，確認 Tunnel 真的通了。 */
  healthCheck: (url: string) => Promise<boolean>;
  startTimeoutMs?: number;
  healthIntervalMs?: number;
};

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const MAX_OUTPUT_CHARS = 64 * 1024;
const KILL_GRACE_MS = 3000;

export class TunnelManager {
  private state: TunnelState = { status: 'stopped', generation: 0 };
  private child: ChildProcess | null = null;
  private starting: Promise<TunnelState> | null = null;
  /** 每次啟動或停止都遞增；進行中的啟動發現它變了就放棄。 */
  private attempt = 0;
  private readonly startTimeoutMs: number;
  private readonly healthIntervalMs: number;

  constructor(private readonly options: TunnelManagerOptions) {
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
    this.healthIntervalMs = options.healthIntervalMs ?? 2_000;
  }

  status(): TunnelState {
    return { ...this.state };
  }

  hasChild(): boolean {
    return this.child !== null;
  }

  start(): Promise<TunnelState> {
    if (this.state.status === 'ready') return Promise.resolve(this.status());
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  async stop(): Promise<TunnelState> {
    this.attempt += 1;
    const wasReady = this.state.status === 'ready';
    const child = this.child;
    this.child = null;
    this.state = { status: 'stopped', generation: this.state.generation + (wasReady ? 1 : 0) };
    if (child) await terminate(child);
    return this.status();
  }

  private async launch(): Promise<TunnelState> {
    const attempt = ++this.attempt;
    const deadline = Date.now() + this.startTimeoutMs;
    this.state = { status: 'starting', generation: this.state.generation };

    const child = spawn(
      this.options.cloudflaredBin,
      ['tunnel', '--no-autoupdate', '--url', this.options.targetUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.child = child;
    let exited = false;
    child.once('exit', (code, signal) => {
      exited = true;
      this.onChildExit(child, code, signal);
    });

    const found = await waitForUrl(child, deadline);
    if (attempt !== this.attempt) return this.status();
    if ('error' in found) return this.fail(attempt, child, found.error);

    while (Date.now() < deadline) {
      let healthy = false;
      try {
        healthy = await this.options.healthCheck(found.url);
      } catch {
        healthy = false;
      }
      if (attempt !== this.attempt) return this.status();
      if (exited) return this.fail(attempt, child, 'cloudflared 在健康檢查期間結束');
      if (healthy) {
        this.state = { status: 'ready', generation: this.state.generation + 1, url: found.url };
        return this.status();
      }
      await sleep(Math.min(this.healthIntervalMs, Math.max(0, deadline - Date.now())));
    }
    return this.fail(attempt, child, '外部健康檢查逾時，未發布網址');
  }

  private async fail(attempt: number, child: ChildProcess, error: string): Promise<TunnelState> {
    if (attempt !== this.attempt) return this.status();
    if (this.child === child) this.child = null;
    this.state = { status: 'failed', generation: this.state.generation, error };
    await terminate(child);
    return this.status();
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.state.status !== 'ready') return;
    this.state = {
      status: 'stopped',
      generation: this.state.generation + 1,
      error: `cloudflared 意外結束（${signal ?? `code ${code}`}）`
    };
  }
}

function waitForUrl(
  child: ChildProcess,
  deadline: number
): Promise<{ url: string } | { error: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result: { url: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      // 之後的輸出照樣讀掉，避免管線塞滿卡住 cloudflared
      child.stdout?.resume();
      child.stderr?.resume();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
      const match = URL_PATTERN.exec(output);
      if (match) finish({ url: match[0] });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => finish({ error: `無法啟動 cloudflared：${error.message}` }));
    child.once('exit', (code, signal) =>
      finish({ error: `cloudflared 在取得網址前結束（${signal ?? `code ${code}`}）` })
    );
    const timer = setTimeout(
      () => finish({ error: '等待 cloudflared 網址逾時' }),
      Math.max(0, deadline - Date.now())
    );
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
