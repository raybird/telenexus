/**
 * 事件投影器：訂閱 event-bus，在關鍵事件發生時立即觸發 context snapshot 重整。
 * 取代純輪詢模式，讓 error-summary / scheduler-status / runner-status 即時反映現況。
 */
import { addEventHook } from './event-bus.js';

type SnapshotFn = () => void;

const TRIGGER_TYPES = new Set([
  'runtime_issue',
  'schedule_fire',
  'schedule_done',
  'schedule_fail',
  'runner_request_done',
  'runner_request_error',
  'request_done',
  'request_error'
]);

/**
 * 兩次事件驅動 snapshot 之間的最小間隔。writeContextSnapshots 是同步的,成本隨資料量線性成長
 * (實測 115K 訊息時單次約 20ms),而上面八種事件在一次排程任務裡就會連續發生數個
 * (schedule_fire → runner_request_done → schedule_done),先前每一個都各寫一輪完整快照。
 * 錯誤爆量時更糟:每個 runtime_issue 都同步阻塞 event loop 一次,而阻塞本身又會製造逾時與錯誤。
 */
const DEFAULT_MIN_INTERVAL_MS = 1000;

function readMinIntervalMs(): number {
  const raw = process.env.CONTEXT_EVENT_MIN_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_INTERVAL_MS;
  return parsed;
}

/**
 * 初始化投影器。傳入 snapshot 重整函式，回傳 unsubscribe。
 *
 * 合併策略是 leading edge + trailing:距離上次夠久就立刻寫(維持「關鍵事件即時反映」的原意),
 * 否則只排一次尾端補寫,把該區間內的連續事件收斂成一次。不會少寫——最後一個事件永遠會被寫出。
 */
export function initEventProjector(
  onSnapshot: SnapshotFn,
  options: { minIntervalMs?: number } = {}
): () => void {
  const minIntervalMs = options.minIntervalMs ?? readMinIntervalMs();
  let lastRunAt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const run = (): void => {
    lastRunAt = Date.now();
    onSnapshot();
  };

  const unsubscribe = addEventHook((type) => {
    if (!TRIGGER_TYPES.has(type)) return;
    if (pendingTimer) return;

    const elapsed = Date.now() - lastRunAt;
    if (elapsed >= minIntervalMs) {
      run();
      return;
    }

    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      run();
    }, minIntervalMs - elapsed);
    pendingTimer.unref?.();
  });

  return () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    unsubscribe();
  };
}
