export class QueueFullError extends Error {
  constructor() {
    super('write queue is full');
    this.name = 'QueueFullError';
  }
}

export class QueueClosedError extends Error {
  constructor() {
    super('write queue is closed');
    this.name = 'QueueClosedError';
  }
}

export interface BatchInfo {
  size: number;
  durationMs: number;
  ok: boolean;
  error?: unknown;
}

export interface BatchQueueOptions<T, R> {
  /** Upper bound on items handed to `process` at once. */
  maxBatchSize: number;
  /** Items allowed to wait (excluding the batch in flight) before push() rejects. */
  maxPending: number;
  /** Must return exactly one result per item, in the same order. */
  process: (items: T[]) => Promise<R[]>;
  /** Observability hook, called after every processed batch. */
  onBatch?: (info: BatchInfo) => void;
}

interface Entry<T, R> {
  item: T;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
}

/**
 * Single-flight, adaptive group-commit queue.
 *
 *  - At most ONE `process` call runs at a time -> writes are serialised, which is
 *    exactly what SQLite (single writer) wants; there is never lock contention.
 *  - Everything that arrives while a batch is being committed is coalesced into the
 *    next batch. Under light load a batch is a single item (lowest latency); under
 *    heavy load batches grow automatically, amortising the transaction + fsync cost.
 *  - Bounded: when `maxPending` items are waiting, push() fails fast so the caller
 *    can shed load (HTTP 503) instead of letting memory and latency grow unbounded.
 *  - Failure isolation: if a multi-item batch fails, its items are retried one by one
 *    so a single poison item cannot fail unrelated submissions.
 */
export class BatchQueue<T, R> {
  private pending: Entry<T, R>[] = [];
  private draining = false;
  private scheduled = false;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly options: BatchQueueOptions<T, R>) {
    if (options.maxBatchSize < 1) throw new RangeError('maxBatchSize must be >= 1');
    if (options.maxPending < 1) throw new RangeError('maxPending must be >= 1');
  }

  /** Items waiting to be committed (not counting the batch currently in flight). */
  get depth(): number {
    return this.pending.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): Promise<R> {
    if (this.closed) return Promise.reject(new QueueClosedError());
    if (this.pending.length >= this.options.maxPending) return Promise.reject(new QueueFullError());

    return new Promise<R>((resolve, reject) => {
      this.pending.push({ item, resolve, reject });
      this.schedule();
    });
  }

  /** Stops accepting new items and resolves once everything already queued is processed. */
  close(): Promise<void> {
    this.closed = true;
    if (!this.draining && !this.scheduled && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private schedule(): void {
    if (this.draining || this.scheduled) return;
    this.scheduled = true;
    // Defer to the next macrotask so that requests arriving in the same tick share a batch.
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, this.options.maxBatchSize);
        const ok = await this.run(batch);
        if (!ok && batch.length > 1) {
          // Isolate the failure: retry each item on its own.
          for (const entry of batch) await this.run([entry]);
        }
      }
    } finally {
      this.draining = false;
      if (this.pending.length > 0) {
        this.schedule();
      } else {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  /** Processes one batch. Returns false if it failed (entries of a multi-item batch are left unsettled). */
  private async run(batch: Entry<T, R>[]): Promise<boolean> {
    const started = performance.now();
    try {
      const results = await this.options.process(batch.map((e) => e.item));
      if (results.length !== batch.length) {
        throw new Error(`batch processor returned ${results.length} results for ${batch.length} items`);
      }
      this.options.onBatch?.({ size: batch.length, durationMs: performance.now() - started, ok: true });
      batch.forEach((entry, i) => entry.resolve(results[i] as R));
      return true;
    } catch (error) {
      this.options.onBatch?.({ size: batch.length, durationMs: performance.now() - started, ok: false, error });
      if (batch.length === 1) batch[0]?.reject(error);
      return false;
    }
  }
}
