type QueuePriority = 'high' | 'normal' | 'low';

export type RunContext = {
  signal: AbortSignal;
};

type QueueTask<T> = {
  id: number;
  source: string;
  priority: QueuePriority;
  run: (ctx: RunContext) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type QueueState = {
  running: boolean;
  currentSource?: string;
  currentAbort?: AbortController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pending: QueueTask<any>[];
};

const priorityWeight: Record<QueuePriority, number> = {
  high: 0,
  normal: 1,
  low: 2
};

export class ExecutionQueue {
  private states = new Map<string, QueueState>();
  private seq = 0;

  getStatus(userId: string): { running: boolean; pending: number; currentSource?: string } {
    const state = this.states.get(userId);
    if (!state) {
      return { running: false, pending: 0 };
    }
    return {
      running: state.running,
      pending: state.pending.length,
      ...(state.currentSource ? { currentSource: state.currentSource } : {})
    };
  }

  enqueue<T>(
    userId: string,
    source: string,
    priority: QueuePriority,
    run: (ctx: RunContext) => Promise<T>
  ): Promise<T> {
    const state = this.states.get(userId) || { running: false, pending: [] };
    this.states.set(userId, state);

    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        id: ++this.seq,
        source,
        priority,
        run,
        resolve,
        reject
      };

      const tw = priorityWeight[priority];
      let lo = 0;
      let hi = state.pending.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const mp = priorityWeight[state.pending[mid]!.priority];
        if (mp < tw || (mp === tw && state.pending[mid]!.id <= task.id)) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      state.pending.splice(lo, 0, task);

      this.drain(userId).catch(() => {});
    });
  }

  /**
   * 中止 userId 當前執行中的任務並清空 pending。
   * @returns true 表示有任務被中止/取消，false 表示該 user 沒任務。
   */
  cancel(userId: string): boolean {
    const state = this.states.get(userId);
    if (!state) return false;

    let touched = false;
    if (state.running && state.currentAbort) {
      state.currentAbort.abort();
      touched = true;
    }
    if (state.pending.length > 0) {
      const pending = state.pending.splice(0, state.pending.length);
      for (const task of pending) {
        task.reject(new Error(`Task cancelled by user (source=${task.source})`));
      }
      touched = true;
    }
    return touched;
  }

  private async drain(userId: string): Promise<void> {
    const state = this.states.get(userId);
    if (!state || state.running) {
      return;
    }

    const task = state.pending.shift();
    if (!task) {
      return;
    }

    state.running = true;
    state.currentSource = task.source;
    const ac = new AbortController();
    state.currentAbort = ac;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const onAbort = () => reject(new Error(`Task aborted (source=${task.source})`));
        ac.signal.addEventListener('abort', onAbort, { once: true });
        task.run({ signal: ac.signal }).then(
          (v) => {
            ac.signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e: unknown) => {
            ac.signal.removeEventListener('abort', onAbort);
            reject(e);
          }
        );
      });
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      state.running = false;
      delete state.currentSource;
      delete state.currentAbort;
      if (state.pending.length === 0) {
        this.states.delete(userId);
      } else {
        void this.drain(userId);
      }
    }
  }
}

export const executionQueue = new ExecutionQueue();
