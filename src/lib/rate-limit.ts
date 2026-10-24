// A fixed-window rate limiter that lives in memory, one window per client key.
export interface RateLimiter {
  /** Counts one request for the key. False when the key has used up its window. */
  take(key: string, nowMs: number): boolean;
}

export interface FixedWindowOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** When more keys than this are tracked, expired windows are dropped. */
  readonly sweepThreshold: number;
}

interface Window {
  startMs: number;
  count: number;
}

export function createFixedWindowLimiter(options: FixedWindowOptions): RateLimiter {
  const windows = new Map<string, Window>();
  const expired = (window: Window, nowMs: number): boolean =>
    nowMs - window.startMs >= options.windowMs;

  const sweep = (nowMs: number): void => {
    for (const [key, window] of windows) if (expired(window, nowMs)) windows.delete(key);
  };

  return {
    take(key, nowMs) {
      if (windows.size > options.sweepThreshold) sweep(nowMs);
      const window = windows.get(key);
      if (window === undefined || expired(window, nowMs)) {
        windows.set(key, { startMs: nowMs, count: 1 });
        return true;
      }
      if (window.count >= options.limit) return false;
      window.count += 1;
      return true;
    },
  };
}
