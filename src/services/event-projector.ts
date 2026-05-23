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

/** 初始化投影器。傳入 snapshot 重整函式，回傳 unsubscribe。 */
export function initEventProjector(onSnapshot: SnapshotFn): () => void {
  return addEventHook((type) => {
    if (TRIGGER_TYPES.has(type)) {
      onSnapshot();
    }
  });
}
