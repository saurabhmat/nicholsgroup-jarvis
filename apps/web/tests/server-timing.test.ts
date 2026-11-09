// T-230 A: the timing helper writes names and durations only, and is off in production unless the operator opts in.
import { describe, expect, it, vi } from "vitest";
import { createTimings, safeName, timingEnabled } from "@/lib/server-timing";

describe("timingEnabled", () => {
  it("is on in next dev", () => expect(timingEnabled({ NODE_ENV: "development" })).toBe(true));
  it("is off in production and test by default", () => {
    expect(timingEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(timingEnabled({ NODE_ENV: "production", APP_ENV: "production" })).toBe(false);
    expect(timingEnabled({})).toBe(false);
  });
  it("is on in production only when the server env var is exactly 1", () => {
    expect(timingEnabled({ NODE_ENV: "production", SERVER_TIMING: "1" })).toBe(true);
    for (const v of ["", "0", "true", "yes", "1 "]) expect(timingEnabled({ NODE_ENV: "production", SERVER_TIMING: v })).toBe(false);
  });
});

describe("createTimings", () => {
  it("records name, start and duration only, and builds a Server-Timing header from them", async () => {
    const lines: string[] = [];
    const t = createTimings((l) => lines.push(l), () => true);
    expect(await t.time("guards.session", async () => "secret-value")).toBe("secret-value");
    await t.time("load.home", () => 1);
    expect(t.header()).toMatch(/^guards\.session;dur=[\d.]+, load\.home;dur=[\d.]+$/);
    expect(t.entries().map((e) => Object.keys(e).sort())).toEqual([["ms", "name", "start"], ["ms", "name", "start"]]);
    // The log line holds the request group id, the name and numbers: nothing from the function's result.
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("secret-value");
    expect(JSON.parse((lines[0] ?? "").replace("[timing] ", ""))).toEqual({ req: t.id, name: "guards.session", start: expect.any(Number), ms: expect.any(Number), at: expect.any(Number) });
  });

  it("when off it only runs the function: nothing recorded, nothing logged, nothing in the header", async () => {
    const log = vi.fn();
    const t = createTimings(log, () => false);
    expect(await t.time("x", async () => 42)).toBe(42);
    expect(log).not.toHaveBeenCalled();
    expect(t.entries()).toEqual([]);
    expect(t.header()).toBe("");
  });

  it("records a failing span and rethrows the same error", async () => {
    const t = createTimings(null, () => true);
    const boom = new Error("boom");
    await expect(t.time("load.x", () => Promise.reject(boom))).rejects.toBe(boom);
    expect(t.entries().map((e) => e.name)).toEqual(["load.x"]);
  });

  it("a name can never split the header or smuggle data into it", async () => {
    const t = createTimings(null, () => true);
    await t.time("a, b;dur=1\r\nx-evil: 1 user@example.test", () => 1);
    expect(t.header()).not.toMatch(/[\r\n@ ]/);
    expect(t.header().split(", ")).toHaveLength(1);
    expect(safeName("Guards.Session")).toBe("guards.session");
    expect(safeName("")).toBe("span");
    expect(safeName("x".repeat(200))).toHaveLength(48);
  });
});
