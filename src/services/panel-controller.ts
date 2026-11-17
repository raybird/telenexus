import type { PanelSessions } from '../web/panel-auth.js';
import type { TunnelClientResult } from '../tunnel/tunnel-client.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { PANEL_PATH } from '../web/panel-paths.js';

/**
 * issue 0030：模型面板入口的生命週期（SCN-001、SCN-005）。
 *
 * - 開啟：tunnel-manager 回報就緒（已通過外部健康檢查）後才設定私聊的選單按鈕；
 *   任何一步失敗都不發布入口。並行的開啟共用同一次。
 * - 關閉：/panel_close、連續 30 分鐘沒有經過驗證的請求（寫入中不算閒置）、Tunnel 意外結束。
 *   一律先讓所有面板憑證失效，再停 Tunnel、恢復一般選單。
 * - 換網址（新世代）時舊憑證失效。已送出的訊息不會被改寫；入口只有選單按鈕。
 */

export type PanelMenu = {
  /** 設定私聊的 web_app 選單按鈕。 */
  show(url: string): Promise<void>;
  /** 恢復一般選單。 */
  reset(): Promise<void>;
};

export type PanelTunnelClient = {
  start(): Promise<TunnelClientResult>;
  status(): Promise<TunnelClientResult>;
  stop(): Promise<TunnelClientResult>;
};

export type PanelControllerOptions = {
  client: PanelTunnelClient;
  menu: PanelMenu;
  sessions: PanelSessions;
  notify: (text: string) => Promise<void>;
  now?: () => number;
  idleMs?: number;
  /** 面板伺服器有沒有在聽；沒有就不開 Tunnel。 */
  panelAvailable?: () => boolean;
};

export type OpenResult =
  | { ok: true; url: string; reused: boolean }
  | { ok: false; message: string };

export type CloseReason = 'manual' | 'idle' | 'exited';

/** 已核准的預設（2026-11-17 Q3）。 */
export const PANEL_IDLE_MS = 30 * 60 * 1000;
/** 狀態查詢要連續失敗幾次才當成 Tunnel 不在了。 */
const STATUS_FAILURES_BEFORE_CLOSE = 2;
const CLOSED_WHILE_OPENING =
  '開啟途中入口已被關閉（/panel_close、閒置或 Tunnel 中斷），沒有發布入口';

export class PanelController {
  private published: { generation: number; url: string } | null = null;
  private opening: Promise<OpenResult> | null = null;
  private lastActivityAt = 0;
  private writes = 0;
  private statusFailures = 0;
  /** close() 與 boot() 的次數；開啟途中比對它，得知是否已被關閉。 */
  private closes = 0;
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(private readonly options: PanelControllerOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? PANEL_IDLE_MS;
  }

  isOpen(): boolean {
    return this.published !== null;
  }

  open(): Promise<OpenResult> {
    if (!this.opening) {
      this.opening = this.doOpen().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async doOpen(): Promise<OpenResult> {
    if (this.options.panelAvailable && !this.options.panelAvailable()) {
      return { ok: false, message: '面板伺服器沒有啟動（請看 panel:start-failed 紀錄）' };
    }
    // close()／boot() 會遞增它；開啟途中被關閉就放棄，不留下已發布的入口（review-87b6cf6 N1）
    const closes = this.closes;
    const started = await this.options.client.start();
    if (!started.ok) return { ok: false, message: describeFailure(started) };
    const { generation, url } = started.state;
    if (started.state.status !== 'ready' || !url) {
      return { ok: false, message: 'tunnel-manager 沒有回報可用的網址' };
    }
    if (closes !== this.closes) return { ok: false, message: CLOSED_WHILE_OPENING };

    const reused = this.published?.generation === generation && this.published.url === url;
    if (!reused) {
      // 換了網址：舊網址拿到的憑證不能沿用（SCN-002）
      this.options.sessions.revokeAll();
      this.published = null;
    }
    try {
      // 沿用時也重送：選單可能被別處重設過，設定同一個網址是冪等的（review-87b6cf6 N2）
      await this.options.menu.show(`${url}${PANEL_PATH}`);
    } catch (error) {
      recordRuntimeIssue('panel:menu-button', error);
      this.options.sessions.revokeAll();
      this.published = null;
      await this.options.client.stop();
      return {
        ok: false,
        message: `無法設定選單按鈕：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (closes !== this.closes) {
      // 設定選單期間被關閉：close() 已經還原過選單，但被這次的設定蓋掉了，再還原一次
      await this.resetMenu();
      return { ok: false, message: CLOSED_WHILE_OPENING };
    }
    if (!reused) {
      this.published = { generation, url };
      this.statusFailures = 0;
    }
    this.touch();
    return { ok: true, url, reused };
  }

  private async resetMenu(): Promise<void> {
    try {
      await this.options.menu.reset();
    } catch (error) {
      recordRuntimeIssue('panel:menu-button', error);
    }
  }

  async close(reason: CloseReason): Promise<{ wasOpen: boolean }> {
    this.closes += 1;
    const wasOpen = this.published !== null;
    this.options.sessions.revokeAll();
    this.published = null;
    this.statusFailures = 0;
    const stopped = await this.options.client.stop();
    if (!stopped.ok) recordRuntimeIssue('panel:tunnel-stop', new Error(stopped.message));
    await this.resetMenu();
    if (wasOpen && reason === 'idle') {
      await this.options.notify(
        `ℹ️ 模型設定面板閒置 ${Math.round(this.idleMs / 60000)} 分鐘，入口已關閉。需要時再輸入 /panel。`
      );
    } else if (wasOpen && reason === 'exited') {
      await this.options.notify(
        '⚠️ 模型設定面板的 Tunnel 已中斷，入口已關閉。重新輸入 /panel 可取得新入口。'
      );
    }
    return { wasOpen };
  }

  /** 每筆經過驗證的面板請求都呼叫。 */
  touch(): void {
    this.lastActivityAt = this.now();
  }

  /** 寫入設定期間不算閒置；回傳的函式在寫完時呼叫。 */
  beginWrite(): () => void {
    this.writes += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writes -= 1;
      this.touch();
    };
  }

  async checkIdle(): Promise<void> {
    if (!this.published || this.writes > 0) return;
    if (this.now() - this.lastActivityAt >= this.idleMs) await this.close('idle');
  }

  async poll(): Promise<void> {
    if (!this.published) return;
    const result = await this.options.client.status();
    if (!this.published) return;
    if (!result.ok) {
      this.statusFailures += 1;
      if (this.statusFailures >= STATUS_FAILURES_BEFORE_CLOSE) await this.close('exited');
      return;
    }
    this.statusFailures = 0;
    const { state } = result;
    if (state.status !== 'ready' || state.generation !== this.published.generation) {
      await this.close('exited');
    }
  }

  /**
   * 服務啟動時呼叫：記憶體憑證已全部失效，殘留的 Tunnel 與選單按鈕都沒有用了。
   * 沒有部署 tunnel-manager 時停止會失敗，這是正常情況，不記成 runtime issue（避免每次啟動都告警）。
   */
  async boot(): Promise<void> {
    this.closes += 1;
    this.options.sessions.revokeAll();
    this.published = null;
    await this.options.client.stop();
    try {
      await this.options.menu.reset();
    } catch (error) {
      console.warn('[Panel] 啟動時恢復選單失敗：', error instanceof Error ? error.message : error);
    }
  }

  startTimers(intervalMs: number = 30_000): void {
    this.stopTimers();
    const run = (fn: () => Promise<void>) => () => {
      fn().catch((error: unknown) => recordRuntimeIssue('panel:timer', error));
    };
    this.timers = [
      setInterval(
        run(() => this.checkIdle()),
        intervalMs
      ),
      setInterval(
        run(() => this.poll()),
        intervalMs
      )
    ];
    for (const timer of this.timers) timer.unref();
  }

  stopTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

function describeFailure(result: Extract<TunnelClientResult, { ok: false }>): string {
  switch (result.reason) {
    case 'unreachable':
      return `連不到 tunnel-manager 服務（${result.message}）。部署的 docker-compose.yml 是否已更新到含 tunnel-manager 的版本？`;
    case 'unauthorized':
      return `tunnel-manager 金鑰不符或讀不到（${result.message}）`;
    case 'timeout':
      return `Tunnel 啟動逾時（${result.message}）`;
    case 'failed':
      return `Tunnel 啟動失敗：${result.message}`;
    case 'bad-response':
      return `tunnel-manager 回應無法辨識（${result.message}）`;
  }
}
