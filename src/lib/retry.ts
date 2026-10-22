const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RetryOpts {
  /** Total attempts including the first call. Default 4 = 1 initial + 3 retries. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. Default 1000ms → 1s, 2s, 4s. */
  baseDelayMs?: number;
  /** Injected for tests so they don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Return false to stop immediately instead of retrying. Use for errors that
   * will never resolve on their own — a 401 is a wrong answer, not a slow one.
   */
  shouldRetry?: (error: unknown) => boolean;
  /**
   * Multiplier applied to each delay. Defaults to a uniform factor in
   * [0.8, 1.2) so 200 phones that fail together do not retry in lockstep.
   * Inject `() => 1` in tests that assert exact delays.
   */
  jitter?: () => number;
}

// Retries a failing async call with exponential backoff, then rethrows the last
// error. Guest phones drop signal constantly at a venue; most failures are a
// tunnel or a lift and resolve within a few seconds, so the retry happens before
// the guest is ever shown an error.
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter ?? (() => 0.8 + Math.random() * 0.4);

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (opts.shouldRetry && !opts.shouldRetry(e)) break;
      const isLast = i === attempts - 1;
      if (!isLast) await sleep(Math.round(baseDelayMs * 2 ** i * jitter()));
    }
  }
  throw lastError;
}
