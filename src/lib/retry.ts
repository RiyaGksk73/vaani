/**
 * Retry with exponential backoff and full jitter.
 *
 * Full jitter (random between 0 and the computed ceiling) rather than fixed
 * backoff: when a rate limit trips, every in-flight worker sees it at the same
 * moment, and identical sleeps would just reconverge them into the same wall.
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to give up immediately (e.g. a 400 that will never succeed). */
  isRetryable?: (error: unknown) => boolean;
  /** Honour a server-provided Retry-After, in ms. */
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    isRetryable = () => true,
    retryAfterMs,
    onRetry,
    signal,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !isRetryable(error)) throw error;
      if (signal?.aborted) throw error;

      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = retryAfterMs?.(error) ?? Math.random() * ceiling;

      onRetry?.(error, attempt, delay);
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs tasks with a bounded number in flight, preserving input order in the
 * result array. Used to turn a batch of rows into a controlled number of
 * concurrent provider calls.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
