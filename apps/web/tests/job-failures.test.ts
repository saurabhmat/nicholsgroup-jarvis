// T-238 part E (web): the tracker's database calls, the banner data (friendly names, threshold, role gating, no content), the sentence.
import { describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createFailureTracker, failureSentence, FUNCTION_NAMES, functionName, jobFailureBannerFor, toJobFailureItems, type JobFailureItem } from "../lib/job-failures";

const CONN = "00000000-0000-4000-8000-0000000000b1";
const row = (over: Record<string, unknown> = {}) => ({ function_id: "conn-sync.mail", consecutive_failures: 3, streak_started_at: "2026-11-13T14:15:00Z", last_error_code: "transient", alerted_at: "2026-11-13T14:45:00Z", ...over });

describe("createFailureTracker", () => {
  const setup = (data: unknown = [{ consecutive_failures: 3, alert: true }], error: unknown = null) => {
    const calls: { lane: string; fn: string; args: unknown }[] = [];
    const tracker = createFailureTracker({
      clientFor: async (lane) => ({ schema: () => ({ rpc: async (fn: string, args: unknown) => (calls.push({ lane, fn, args }), { data, error }) }) }) as never,
      enabledLanes: () => ["PKG"],
    });
    return { tracker, calls };
  };
  it("records through core.job_failure_record with the lane's own client and parses the answer", async () => {
    const { tracker, calls } = setup();
    await expect(tracker.recordFailure("PKG", "conn-sync.mail", CONN, "transient")).resolves.toEqual({ consecutive: 3, alert: true });
    expect(calls).toEqual([{ lane: "PKG", fn: "job_failure_record", args: { p_lane: "PKG", p_function: "conn-sync.mail", p_connection: CONN, p_code: "transient" } }]);
    expect(tracker.enabledLanes()).toEqual(["PKG"]);
  });
  it("clears through core.job_failure_clear", async () => {
    const { tracker, calls } = setup(null);
    await tracker.recordSuccess("PKG", "cal-ingest-delta", "");
    expect(calls[0]).toEqual({ lane: "PKG", fn: "job_failure_clear", args: { p_lane: "PKG", p_function: "cal-ingest-delta", p_connection: "" } });
  });
  it("a database error is a generic error with no database text; an odd answer is 'no alert'", async () => {
    const bad = setup(null, { message: "relation job_failures password=x" });
    const err = (await bad.tracker.recordFailure("PKG", "f", "", "failed").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/password|relation/);
    await expect(setup({ nope: 1 }).tracker.recordFailure("PKG", "f", "", "failed")).resolves.toEqual({ consecutive: 0, alert: false });
  });
});

describe("toJobFailureItems", () => {
  it("keeps only alerted rows with at least 3 failures, with friendly names and a fixed detail for known codes", () => {
    const items = toJobFailureItems([row(), row({ function_id: "cal-ingest-delta", consecutive_failures: 2 }), row({ function_id: "news-daily", alerted_at: null }), row({ function_id: "conn-sync.calendar", consecutive_failures: 5, last_error_code: "reconnect_required" })]);
    expect(items.map((i) => [i.name, i.failures, i.detail])).toEqual([
      ["Calendar sync", 5, "The provider access expired. Reconnect in Settings."],
      ["Mail sync", 3, "The provider had a temporary problem; retrying."],
    ]);
  });
  it("an unknown function id is 'A scheduled job' (never the raw id); a code that is not a short code or is generic gives no detail", () => {
    const [a, b, c] = toJobFailureItems([row({ function_id: "mystery-fn", last_error_code: "failed" }), row({ function_id: "x2", last_error_code: "Bearer abc jane@example.test" }), row({ function_id: "lane-x", last_error_code: "lane_unavailable" })]);
    expect([a?.name, b?.name, c?.name]).toEqual(["A scheduled job", "A scheduled job", "A scheduled job"]);
    expect([a?.detail, b?.detail, c?.detail]).toEqual([null, null, null]);
    expect(functionName("__proto__")).toBe("A scheduled job");
    expect(Object.keys(FUNCTION_NAMES)).toContain("conn-sync.mail");
  });
  it("ignores malformed input", () => {
    expect(toJobFailureItems(null)).toEqual([]);
    expect(toJobFailureItems([null, 3, {}, row({ consecutive_failures: "3" })])).toEqual([]);
  });
  it("the sentence names the Eastern start of the streak", () => {
    const [i] = toJobFailureItems([row({ streak_started_at: "2026-11-13T14:15:00Z" })]) as [JobFailureItem];
    expect(failureSentence(i, new Date("2026-11-13T15:00:00Z"))).toBe("Mail sync has failed 3 times in a row since 9:15 AM ET.");
    expect(failureSentence({ ...i, since: null }, new Date())).toBe("Mail sync has failed 3 times in a row.");
  });
});

describe("jobFailureBannerFor", () => {
  const client = (data: unknown, error: unknown = null, seen: unknown[][] = []) => ({
    schema: (s: string) => ({
      from: (t: string) => {
        seen.push(["from", s, t]);
        const q: Record<string, (...a: unknown[]) => unknown> = {
          select: (c) => (seen.push(["select", c]), q),
          eq: (c, v) => (seen.push(["eq", c, v]), q),
          gte: (c, v) => (seen.push(["gte", c, v]), q),
          not: (...a) => (seen.push(["not", ...a]), q),
          limit: async () => ({ data, error }),
        };
        return q;
      },
    }),
  });
  const guards = (over: { role?: unknown; client?: unknown } = {}) => ({
    requireRole: vi.fn<(lane: string, roles: readonly string[]) => Promise<never>>(async () => {
      if (over.role) throw over.role;
      return { client: over.client } as never;
    }),
  });

  it("asks for owner or admin_technical, reads the lane's alerted rows with the user's client, and returns the items", async () => {
    const seen: unknown[][] = [];
    const g = guards({ client: client([row()], null, seen) });
    const items = await jobFailureBannerFor(g, "PKG");
    expect(items?.map((i) => i.name)).toEqual(["Mail sync"]);
    expect([...(g.requireRole.mock.calls[0]?.[1] ?? [])].sort()).toEqual(["admin_technical", "owner"]);
    expect(seen).toContainEqual(["from", "core", "job_failures"]);
    expect(seen).toContainEqual(["eq", "lane_id", "PKG"]);
    expect(seen).toContainEqual(["gte", "consecutive_failures", 3]);
    expect(seen).toContainEqual(["not", "alerted_at", "is", null]);
  });
  it("any other role, AAL1 or another lane (an AuthError) gets null and nothing is read", async () => {
    const seen: unknown[][] = [];
    for (const reason of ["forbidden", "mfa_required", "no_session"] as const) {
      expect(await jobFailureBannerFor(guards({ role: new AuthError(reason), client: client([row()], null, seen) }), "PKG")).toBeNull();
    }
    expect(seen).toEqual([]);
  });
  it("nothing to warn about, an unreadable table or an outage in the role check is null (the banner is advisory)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await jobFailureBannerFor(guards({ client: client([]) }), "PKG")).toBeNull();
    expect(await jobFailureBannerFor(guards({ client: client(null, { message: "db text" }) }), "PKG")).toBeNull();
    expect(await jobFailureBannerFor(guards({ role: new Error("auth outage") }), "PKG")).toBeNull();
    expect(JSON.stringify(quiet.mock.calls)).not.toMatch(/db text/);
    quiet.mockRestore();
  });
});
