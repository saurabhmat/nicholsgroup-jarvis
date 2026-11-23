// SL2 (T-281 review): idle rate-limit buckets are dropped once the map is large, and pacing of a busy or recent bucket is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BUCKETS, RateLimiter } from "./rate-limit";

afterEach(() => RateLimiter.resetForTests());
const limit = { requests: 1, perMs: 1000 };

describe("bucket eviction", () => {
  it("drops idle buckets past the cap, keeps recent ones, and a dropped bucket behaves like a new one", async () => {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const first = RateLimiter.for("k:first", limit, clock);
    await first.take();
    await new Promise((r) => setTimeout(r, 0)); // let the call settle
    for (let i = 0; i < MAX_BUCKETS - 1; i += 1) RateLimiter.for(`k:${String(i)}`, limit, clock);
    t += 120_000; // everything above is idle now
    const recent = RateLimiter.for("k:recent", limit, clock); // the sweep runs here
    await recent.take();
    expect(RateLimiter.for("k:first", limit, clock)).not.toBe(first); // swept
    expect(RateLimiter.for("k:recent", limit, clock)).toBe(recent); // recent: kept
    // the pacing of a kept bucket is unchanged: the second call waits for its second
    const before = t;
    await recent.take();
    expect(t - before).toBe(1000);
  });

  it("a bucket with a waiter is never dropped", async () => {
    let t = 0;
    const clock = { now: () => t, sleep: (ms: number) => new Promise<void>((r) => setTimeout(() => ((t += ms), r()), 1)) };
    const busy = RateLimiter.for("k:busy", limit, clock);
    await busy.take();
    const waiting = busy.take(); // queued
    t += 120_000;
    for (let i = 0; i < MAX_BUCKETS; i += 1) RateLimiter.for(`k:${String(i)}`, limit, clock);
    expect(RateLimiter.for("k:busy", limit, clock)).toBe(busy);
    await waiting;
  });
});
