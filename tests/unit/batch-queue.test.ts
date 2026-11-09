import { describe, expect, it } from 'vitest';
import { BatchQueue, QueueClosedError, QueueFullError } from '../../src/utils/batch-queue';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('BatchQueue', () => {
  it('coalesces items pushed in the same tick into one batch and preserves order', async () => {
    const batches: number[][] = [];
    const queue = new BatchQueue<number, number>({
      maxBatchSize: 100,
      maxPending: 1000,
      process: async (items) => {
        batches.push(items);
        return items.map((i) => i * 10);
      },
    });

    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => queue.push(i)));

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(batches).toEqual([[1, 2, 3, 4, 5]]);
  });

  it('never runs two batches concurrently and respects maxBatchSize', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    const queue = new BatchQueue<number, number>({
      maxBatchSize: 3,
      maxPending: 1000,
      process: async (items) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sizes.push(items.length);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return items;
      },
    });

    await Promise.all(Array.from({ length: 10 }, (_, i) => queue.push(i)));

    expect(maxInFlight).toBe(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('accumulates items that arrive while a batch is in flight into the next batch', async () => {
    const gate = deferred<void>();
    const batches: number[][] = [];
    const queue = new BatchQueue<number, number>({
      maxBatchSize: 100,
      maxPending: 1000,
      process: async (items) => {
        batches.push(items);
        if (batches.length === 1) await gate.promise;
        return items;
      },
    });

    const first = queue.push(1);
    await new Promise((r) => setImmediate(r)); // first batch starts
    const rest = [2, 3, 4].map((i) => queue.push(i));
    gate.resolve();
    await Promise.all([first, ...rest]);

    expect(batches).toEqual([[1], [2, 3, 4]]);
  });

  it('rejects with QueueFullError when maxPending is reached (back-pressure)', async () => {
    const gate = deferred<void>();
    const queue = new BatchQueue<number, number>({
      maxBatchSize: 1,
      maxPending: 2,
      process: async (items) => {
        await gate.promise;
        return items;
      },
    });

    const p1 = queue.push(1);
    await new Promise((r) => setImmediate(r)); // item 1 in flight, not pending
    const p2 = queue.push(2);
    const p3 = queue.push(3);
    await expect(queue.push(4)).rejects.toBeInstanceOf(QueueFullError);

    gate.resolve();
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([1, 2, 3]);
  });

  it('isolates a failing item: other items in the same batch still succeed', async () => {
    const queue = new BatchQueue<number, number>({
      maxBatchSize: 10,
      maxPending: 100,
      process: async (items) => {
        if (items.includes(13)) throw new Error('poison');
        return items;
      },
    });

    const results = await Promise.allSettled([1, 13, 2].map((i) => queue.push(i)));

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('close() drains queued items and then rejects new pushes', async () => {
    const processed: number[] = [];
    const queue = new BatchQueue<number, number>({
      maxBatchSize: 2,
      maxPending: 100,
      process: async (items) => {
        await new Promise((r) => setTimeout(r, 2));
        processed.push(...items);
        return items;
      },
    });

    const pending = [1, 2, 3, 4, 5].map((i) => queue.push(i));
    await queue.close();

    expect(processed).toEqual([1, 2, 3, 4, 5]);
    await expect(Promise.all(pending)).resolves.toEqual([1, 2, 3, 4, 5]);
    await expect(queue.push(6)).rejects.toBeInstanceOf(QueueClosedError);
  });
});
