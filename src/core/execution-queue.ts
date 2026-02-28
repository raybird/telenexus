type QueuePriority = 'high' | 'normal' | 'low';

type QueueTask<T> = {
  id: number;
  source: string;
  priority: QueuePriority;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type QueueState = {
  running: boolean;
  currentSource?: string;
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

  async enqueue<T>(
    userId: string,
    source: string,
    priority: QueuePriority,
    run: () => Promise<T>
  ): Promise<T> {
    const state = this.states.get(userId) || { running: false, pending: [] };
    this.states.set(userId, state);

    return new Promise<T>((resolve, reject) => {
      state.pending.push({
        id: ++this.seq,
        source,
        priority,
        run,
        resolve,
        reject
      });
      state.pending.sort((a, b) => {
        const pa = priorityWeight[a.priority];
        const pb = priorityWeight[b.priority];
        if (pa !== pb) {
          return pa - pb;
        }
        return a.id - b.id;
      });
      this.drain(userId).catch(() => {
        // individual task rejections are handled per task
      });
    });
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
    try {
      const result = await task.run();
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      state.running = false;
      delete state.currentSource;
      if (state.pending.length === 0) {
        this.states.delete(userId);
      } else {
        void this.drain(userId);
      }
    }
  }
}

export const executionQueue = new ExecutionQueue();
