// Per-provider (or per-connection) rate limiting for the HTTP client (T-034). A sliding window: at most `requests`
// calls start in any `perMs` window per bucket key. Buckets are process-wide, so every client for the same key (e.g.
// one QuickBooks realm) shares one budget. The client keys buckets by provider, lane and rate-limit key, so one lane's
// backfill never queues another lane's calls (rule 1). Inngest's per-connection concurrency key (architecture §6) is
// the cross-process control; this one keeps a single process from bursting past the provider's limit.

export type RateLimit = { requests: number; perMs: number };

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

const buckets = new Map<string, RateLimiter>();
/** Idle buckets are dropped once the map holds this many (SL2): a bucket nobody waits on and nobody touched for a minute behaves exactly like a new one, so dropping it changes no pacing. */
export const MAX_BUCKETS = 2000;
const IDLE_MS = 60_000;

/** The abort reason as an error (the caller's own reason when it gave one). */
export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** `promise`, or a rejection as soon as `signal` aborts (the underlying work is not stopped). */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

export class RateLimiter {
  readonly #limit: RateLimit;
  readonly #clock: Clock;
  readonly #starts: number[] = [];
  #queue: Promise<void> = Promise.resolve();
  #pending = 0;
  #touched = 0;

  private constructor(limit: RateLimit, clock: Clock) {
    if (!Number.isInteger(limit.requests) || limit.requests < 1 || !(limit.perMs > 0) || !Number.isFinite(limit.perMs)) {
      throw new TypeError("rate limit needs requests >= 1 and a finite perMs > 0");
    }
    this.#limit = { ...limit };
    this.#clock = clock;
  }

  /** The shared limiter for a bucket key. Asking for the same key with a different limit is a bug and throws. */
  static for(key: string, limit: RateLimit, clock: Clock): RateLimiter {
    let b = buckets.get(key);
    const now = clock.now();
    if (!b) {
      if (buckets.size >= MAX_BUCKETS) {
        for (const [k, v] of buckets) if (v.#pending === 0 && now - v.#touched > Math.max(IDLE_MS, v.#limit.perMs * 2)) buckets.delete(k);
      }
      b = new RateLimiter(limit, clock);
      buckets.set(key, b);
    } else if (b.#limit.requests !== limit.requests || b.#limit.perMs !== limit.perMs) {
      throw new TypeError(`rate limit for ${key} is already set to a different value`);
    }
    b.#touched = now;
    return b;
  }

  /** Test helper: drop every bucket. */
  static resetForTests(): void {
    buckets.clear();
  }

  /**
   * Resolves when a call may start. Calls are admitted in order. An aborted caller is rejected at once and its turn,
   * when it comes, is skipped without using a slot.
   */
  take(signal?: AbortSignal): Promise<void> {
    this.#pending += 1;
    const next = this.#queue.then(async () => {
      for (;;) {
        if (signal?.aborted) throw abortError(signal);
        const now = this.#clock.now();
        while (this.#starts.length > 0 && (this.#starts[0] as number) <= now - this.#limit.perMs) this.#starts.shift();
        if (this.#starts.length < this.#limit.requests) {
          this.#starts.push(now);
          return;
        }
        await raceAbort(this.#clock.sleep((this.#starts[0] as number) + this.#limit.perMs - now), signal);
      }
    });
    this.#queue = next.catch(() => undefined);
    void this.#queue.then(() => {
      this.#pending -= 1;
      this.#touched = this.#clock.now();
    });
    return raceAbort(next, signal);
  }
}
