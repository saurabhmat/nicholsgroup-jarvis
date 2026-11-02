// Per-provider (or per-connection) rate limiting for the HTTP client (T-034). A sliding window: at most `requests`
// calls start in any `perMs` window per bucket key. Buckets are process-wide, so every client for the same key (e.g.
// one QuickBooks realm) shares one budget. Inngest's per-connection concurrency key (architecture §6) is the
// cross-process control; this one keeps a single process from bursting past the provider's limit.

export type RateLimit = { requests: number; perMs: number };

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

const buckets = new Map<string, RateLimiter>();

export class RateLimiter {
  readonly #limit: RateLimit;
  readonly #clock: Clock;
  readonly #starts: number[] = [];
  #queue: Promise<void> = Promise.resolve();

  private constructor(limit: RateLimit, clock: Clock) {
    if (!Number.isInteger(limit.requests) || limit.requests < 1 || !(limit.perMs > 0)) {
      throw new TypeError("rate limit needs requests >= 1 and perMs > 0");
    }
    this.#limit = limit;
    this.#clock = clock;
  }

  /** The shared limiter for a bucket key. The first caller's limit wins for that key. */
  static for(key: string, limit: RateLimit, clock: Clock): RateLimiter {
    let b = buckets.get(key);
    if (!b) {
      b = new RateLimiter(limit, clock);
      buckets.set(key, b);
    }
    return b;
  }

  /** Test helper: drop every bucket. */
  static resetForTests(): void {
    buckets.clear();
  }

  /** Resolves when a call may start. Calls are admitted in order. */
  take(): Promise<void> {
    const next = this.#queue.then(async () => {
      for (;;) {
        const now = this.#clock.now();
        while (this.#starts.length > 0 && (this.#starts[0] as number) <= now - this.#limit.perMs) this.#starts.shift();
        if (this.#starts.length < this.#limit.requests) {
          this.#starts.push(now);
          return;
        }
        await this.#clock.sleep((this.#starts[0] as number) + this.#limit.perMs - now);
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
