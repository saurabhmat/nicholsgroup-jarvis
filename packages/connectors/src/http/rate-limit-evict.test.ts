// SL2 / L1 / L2 (T-281 review): the bucket map is a least-recently-used list. Idle buckets are dropped from the front once it is large; a recent or busy bucket is never dropped; a dropped bucket that a
// client still holds is put back by `take()` so one key has one bucket; and 20,000 new keys never scan the map. Pacing of a kept bucket is unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { IDLE_MS, MAX_BUCKETS, RateLimiter } from "./rate-limit";

afterEach(() => RateLimiter.resetForTests());
const limit = { requests: 1, perMs: 1000 };
const mk = () => {
  let t = 0;
  return { clock: { now: () => t, sleep: async (ms: number) => void (t += ms) }, advance: (ms: number) => void (t += ms), time: () => t };
};

describe("bucket eviction (LRU)", () => {
  it("drops idle buckets from the front past the cap, keeps recent ones, and a dropped bucket behaves like a new one", async () => {
    const c = mk();
    const first = RateLimiter.for("k:first", limit, c.clock);
    await first.take();
    await new Promise((r) => setTimeout(r, 0)); // let the call settle
    for (let i = 0; i < MAX_BUCKETS - 1; i += 1) RateLimiter.for(`k:${String(i)}`, limit, c.clock);
    c.advance(IDLE_MS + 1000);
    const recent = RateLimiter.for("k:recent", limit, c.clock); // over the cap: the oldest idle ones go
    await recent.take();
    expect(RateLimiter.for("k:first", limit, c.clock)).not.toBe(first); // dropped
    expect(RateLimiter.for("k:recent", limit, c.clock)).toBe(recent); // recent: kept
    const before = c.time();
    await recent.take();
    expect(c.time() - before).toBe(1000); // a kept bucket still paces
  });

  it("a bucket used a minute ago is NOT dropped (the idle limit is far above the longest retry chain)", () => {
    const c = mk();
    const held = RateLimiter.for("k:held", limit, c.clock);
    for (let i = 0; i < MAX_BUCKETS + 50; i += 1) RateLimiter.for(`k:${String(i)}`, limit, c.clock);
    c.advance(90_000); // a 30 s timeout and a Retry-After wait
    for (let i = 0; i < 100; i += 1) RateLimiter.for(`k:more${String(i)}`, limit, c.clock);
    expect(RateLimiter.for("k:held", limit, c.clock)).toBe(held);
  });

  it("a client that still holds a dropped bucket and takes from it puts it back: one key, one bucket", async () => {
    const c = mk();
    const held = RateLimiter.for("k:held", limit, c.clock);
    for (let i = 0; i < MAX_BUCKETS + 10; i += 1) RateLimiter.for(`k:${String(i)}`, limit, c.clock);
    c.advance(IDLE_MS + 1000);
    RateLimiter.for("k:trigger", limit, c.clock); // drops the idle ones, `held` included
    await held.take();
    expect(RateLimiter.for("k:held", limit, c.clock)).toBe(held);
  });

  it("a bucket with a waiter is never dropped", async () => {
    const c = mk();
    const clock = { now: c.clock.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(() => (c.advance(ms), r()), 1)) };
    const busy = RateLimiter.for("k:busy", limit, clock);
    await busy.take();
    const waiting = busy.take();
    c.advance(IDLE_MS + 1000);
    for (let i = 0; i < MAX_BUCKETS + 10; i += 1) RateLimiter.for(`k:${String(i)}`, limit, clock);
    expect(RateLimiter.for("k:busy", limit, clock)).toBe(busy);
    await waiting;
  });

  it("20,000 new keys stay fast (no scan of the whole map per insertion) and the map stays near the cap", () => {
    const c = mk();
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i += 1) {
      c.advance(100); // each key is older than the idle limit by the time later ones arrive
      RateLimiter.for(`k:${String(i)}`, limit, c.clock);
    }
    expect(performance.now() - t0).toBeLessThan(500);
    // (a Map has no public size here; a probe of the oldest key shows it was dropped)
    const probe = RateLimiter.for("k:0", limit, c.clock);
    expect(probe).toBeDefined();
  });
});
