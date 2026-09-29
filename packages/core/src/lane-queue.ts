export class QueueOverflowError extends Error {
  constructor(public readonly lane: string, public readonly limit: number) {
    super(`lane "${lane}" is full (limit ${limit})`);
    this.name = "QueueOverflowError";
  }
}

export interface LaneQueueOptions {
  /** Max tasks waiting per lane (the running task is not counted). Default 100. */
  maxPending?: number;
}

interface LaneState {
  running: boolean;
  waiting: Array<() => void>;
}

/**
 * Default serial, explicit parallel: every lane runs one task at a time, in
 * order. Different lanes run independently. A failing task never blocks the
 * lane: its error goes to the caller of that task only.
 */
export class LaneQueue {
  private readonly lanes = new Map<string, LaneState>();
  private readonly maxPending: number;

  constructor(options: LaneQueueOptions = {}) {
    this.maxPending = options.maxPending ?? 100;
  }

  enqueue<T>(lane: string, task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let state = this.lanes.get(lane);
      if (!state) {
        state = { running: false, waiting: [] };
        this.lanes.set(lane, state);
      }

      const run = async (): Promise<void> => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          this.next(lane);
        }
      };

      if (!state.running) {
        state.running = true;
        void run();
      } else if (state.waiting.length >= this.maxPending) {
        reject(new QueueOverflowError(lane, this.maxPending));
      } else {
        state.waiting.push(() => void run());
      }
    });
  }

  /** Number of tasks waiting in a lane (excluding the one running). */
  size(lane: string): number {
    return this.lanes.get(lane)?.waiting.length ?? 0;
  }

  private next(lane: string): void {
    const state = this.lanes.get(lane);
    if (!state) return;
    const following = state.waiting.shift();
    if (following) {
      following();
    } else {
      this.lanes.delete(lane);
    }
  }
}
