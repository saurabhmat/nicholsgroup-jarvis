// T-235 part 1: the automatic-summary server actions. Owner only (the guard is asked for the owner role), the lane id is checked
// first, the model must be configured, SQL gate codes come back as {started: false, gate} without a run, a claimed run is scheduled
// with after() (the action returns at once) using only what was captured before it, and the poll returns the run state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createMockProvider, jsonResult } from "@nichols/ai/testing";

const state = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireLane: vi.fn(),
  rpc: vi.fn(),
  provider: vi.fn(),
  after: vi.fn(),
  cookieGet: vi.fn(),
  run: vi.fn(),
  brainLoad: vi.fn(),
  storeDeps: null as null | { clientFor: (l: string) => Promise<unknown> },
  cookiesCalledInAfter: false,
  inAfter: false,
}));
vi.mock("@/lib/guards", () => ({ guards: async () => ({ requireRole: state.requireRole, requireLane: state.requireLane }) }));
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: (...a: unknown[]) => state.provider(...a) }));
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (state.inAfter) state.cookiesCalledInAfter = true;
    return { get: (n: string) => state.cookieGet(n) };
  },
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => state.after(fn) }));
vi.mock("@/lib/briefing-setup", () => ({ aiSetupFailure: () => null }));
vi.mock("@nichols/brain/server", () => ({
  createBrainStore: (d: { clientFor: (l: string) => Promise<unknown> }) => {
    state.storeDeps = d;
    return {};
  },
  loadBrainPromptContext: (...a: unknown[]) => state.brainLoad(...a),
}));
vi.mock("@nichols/connectors/google", () => ({ readGmailBody: async () => ({ text: "" }) }));
vi.mock("@/lib/briefing-proposals", () => ({ replyProposer: () => async () => "p1" }));
vi.mock("@/lib/briefing-run", async (orig) => ({ ...(await orig<typeof import("@/lib/briefing-run")>()), runBriefingBounded: (...a: unknown[]) => state.run(...a) }));
import { LaneAccessError } from "@nichols/core/lane-router";
import { briefingRunState, ensureFreshBriefing, regenerateBriefing } from "@/app/[laneId]/briefing-actions";

const MAIL_COVERAGE = [{ stream: "mail", account: "ops@example.test", connection_id: "c1", provider: "google", status: "active", configured: true, last_sync_at: "2026-11-11T14:59:00Z" }];
const client = () => ({
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { llm_allowed_categories: ["email", "calendar"], store_outbound_drafts: false }, error: null }) }) }) }),
    rpc: (fn: string, args: unknown) => state.rpc(fn, args),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  state.cookiesCalledInAfter = false;
  state.inAfter = false;
  state.requireRole.mockResolvedValue({ client: client(), session: { userId: "u" } });
  state.rpc.mockImplementation(async (fn: string) =>
    fn === "briefing_coverage" ? { data: MAIL_COVERAGE, error: null } : fn === "briefing_claim_release" ? { data: true, error: null } : fn.startsWith("briefing_claim") ? { data: { id: "claim-1", gate: null }, error: null } : { data: null, error: null },
  );
  state.requireLane.mockImplementation(async (l: string) => ({ client: { lane: l }, session: { userId: "u" } }));
  state.brainLoad.mockResolvedValue({ brainUser: null, laneBrain: {}, notes: [] });
  state.storeDeps = null;
  state.provider.mockReturnValue({ configured: true, provider: createMockProvider([jsonResult({})]) });
  state.cookieGet.mockReturnValue({ value: "America/New_York" });
  state.run.mockResolvedValue({ id: "b1", status: "ready" });
  state.after.mockImplementation(() => undefined);
});

describe.each([
  ["ensureFreshBriefing", ensureFreshBriefing, "briefing_claim_auto"],
  ["regenerateBriefing", regenerateBriefing, "briefing_claim_regenerate"],
] as const)("%s", (_name, action, claimFn) => {
  it("asks for the owner role only; a non-owner gets forbidden, no claim, no run", async () => {
    state.requireRole.mockRejectedValueOnce(new AuthError("forbidden" as never));
    expect(await action("PKG")).toEqual({ error: "forbidden" });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.after).not.toHaveBeenCalled();
    await action("PKG");
    expect(state.requireRole).toHaveBeenLastCalledWith("PKG", ["owner"]);
  });

  it("refuses a malformed lane id before any guard", async () => {
    expect(await action("pkg; drop")).toEqual({ error: "forbidden" });
    expect(await action(5 as never)).toEqual({ error: "forbidden" });
    expect(state.requireRole).not.toHaveBeenCalled();
  });

  it("model not configured: a coded error with the admin hint, no claim (the cap is not spent)", async () => {
    state.provider.mockReturnValue({ configured: false, missing: [], refused: [] });
    const r = await action("PKG");
    expect(r).toMatchObject({ error: "not_configured", reason: "key_missing" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("claims in SQL, returns {started: true} at once and schedules the run with after() (not run inline)", async () => {
    expect(await action("PKG")).toEqual({ started: true });
    expect(state.rpc).toHaveBeenCalledWith(claimFn, { p_lane: "PKG" });
    expect(state.brainLoad).toHaveBeenCalledTimes(1); // loaded before after(): cookies are available then
    expect(state.after.mock.calls).toHaveLength(1);
    expect(state.after).toHaveBeenCalledTimes(1);
    expect(state.run).not.toHaveBeenCalled(); // only when after() runs the callback
    expect(state.provider).toHaveBeenCalledWith({ timeoutMs: 60_000, maxRetries: 1 });
  });

  it("the after() callback runs the bounded briefing with the owner's client and the cookie values read BEFORE it", async () => {
    await action("PKG");
    state.cookiesCalledInAfter = false;
    state.inAfter = true;
    const cb = state.after.mock.calls[0]?.[0] as () => Promise<void>;
    await cb();
    expect(state.cookiesCalledInAfter).toBe(false); // after() cannot read cookies: nothing here asked for them
    expect(state.run).toHaveBeenCalledTimes(1);
    const [deps, input] = state.run.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ laneId: "PKG", ownerUserId: "u", trigger: "manual", viewerTz: "America/New_York" });
    expect(deps.policy).toEqual({ email: true, calendar: true, storeDrafts: false });
    expect(typeof deps.save).toBe("function");
  });

  it("a run that throws inside after() is logged by class only and never escapes", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.run.mockRejectedValue(new Error("SECRET-DETAIL"));
    await action("PKG");
    await (state.after.mock.calls[0]?.[0] as () => Promise<void>)();
    expect(JSON.stringify(err.mock.calls)).not.toContain("SECRET-DETAIL");
    err.mockRestore();
  });

  it("no mail view or no mail stream: gate no_sources BEFORE the claim, nothing scheduled", async () => {
    state.rpc.mockImplementation(async (fn: string) => (fn === "briefing_coverage" ? { data: [{ stream: "calendar", account: "ops@example.test", connection_id: "c1", provider: "google", status: "active", configured: true, last_sync_at: null }], error: null } : { data: { id: "x", gate: null }, error: null }));
    expect(await action("PKG")).toEqual({ started: false, gate: "no_sources" });
    expect(state.rpc.mock.calls.map((c) => c[0])).not.toContain(claimFn);
    expect(state.after).not.toHaveBeenCalled();
  });

  it("the brain context never gets the current lane's client for another lane; after the load window every request is refused", async () => {
    let storeFor: ((l: string) => Promise<unknown>) | null = null;
    state.brainLoad.mockImplementation(async () => {
      storeFor = state.storeDeps?.clientFor ?? null;
      const home = (await storeFor?.("APK")) as { lane: string } | undefined;
      expect(home).toEqual({ lane: "APK" }); // its own requireLane, not the PKG client
      return { brainUser: null, laneBrain: {}, notes: [] };
    });
    await action("PKG");
    expect(state.requireLane).toHaveBeenCalledWith("APK");
    await expect(Promise.resolve().then(() => (storeFor as unknown as (l: string) => Promise<unknown>)("ZZZ"))).rejects.toBeInstanceOf(LaneAccessError);
    expect(state.requireLane).not.toHaveBeenCalledWith("ZZZ");
  });

  it("a failure between the claim and after() releases the claim (no claim leaks)", async () => {
    state.after.mockImplementation(() => {
      throw new Error("after unavailable");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await action("PKG")).toEqual({ error: "unavailable" });
    expect(state.rpc).toHaveBeenCalledWith("briefing_claim_release", { p_lane: "PKG", p_claim: "claim-1" });
    err.mockRestore();
  });

  it("a brain load that throws or hangs does not stop the run", async () => {
    state.brainLoad.mockRejectedValue(new Error("boom"));
    expect(await action("PKG")).toEqual({ started: true });
    expect(state.rpc).not.toHaveBeenCalledWith("briefing_claim_release", expect.anything());
    const cb = state.after.mock.calls[0]?.[0] as () => Promise<void>;
    await cb();
    expect((state.run.mock.calls[0] as [{ brain: unknown }])[0].brain).toBeNull();
  });

  it("the run's time budget counts from the action's start (timer before the brain load); a run that throws releases its claim", async () => {
    await action("PKG");
    const cb = state.after.mock.calls[0]?.[0] as () => Promise<void>;
    await cb();
    const opts = state.run.mock.calls[0]?.[2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBeLessThanOrEqual(60_000);
    expect(opts.timeoutMs).toBeGreaterThan(50_000);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.run.mockRejectedValue(new Error("x"));
    await action("PKG");
    await (state.after.mock.calls[1]?.[0] as () => Promise<void>)();
    expect(state.rpc).toHaveBeenCalledWith("briefing_claim_release", { p_lane: "PKG", p_claim: "claim-1" });
    err.mockRestore();
  });

  it("every SQL gate comes back as a code and nothing is scheduled", async () => {
    for (const gate of ["not_stale", "running", "cap_reached", "cooldown", "rate_limited"]) {
      state.rpc.mockImplementation(async (fn: string) => (fn === "briefing_coverage" ? { data: MAIL_COVERAGE, error: null } : { data: { id: null, gate }, error: null }));
      expect(await action("PKG")).toEqual({ started: false, gate });
    }
    expect(state.after).not.toHaveBeenCalled();
  });

  it("an unknown gate string is a no-op (not_stale), never running; a claim error is unavailable without SQL detail", async () => {
    state.rpc.mockImplementation(async (fn: string) => (fn === "briefing_coverage" ? { data: MAIL_COVERAGE, error: null } : { data: { id: null, gate: "weird" }, error: null }));
    expect(await action("PKG")).toEqual({ started: false, gate: "not_stale" });
    state.rpc.mockImplementation(async (fn: string) => (fn === "briefing_coverage" ? { data: MAIL_COVERAGE, error: null } : { data: null, error: { message: "relation x does not exist: secret", code: "42P01" } }));
    expect(await action("PKG")).toEqual({ error: "unavailable" });
    expect(state.after).not.toHaveBeenCalled();
  });
});

describe("briefingRunState", () => {
  it("returns the owner's run state; null for a non-owner, a bad lane or an error", async () => {
    state.rpc.mockResolvedValueOnce({ data: [{ running: true, last_regenerate_at: null, runs_today: 2, latest_prepared_at: "2026-11-12T10:00:00Z", last_attempt_at: "2026-11-12T10:00:00Z" }], error: null });
    expect(await briefingRunState("PKG")).toEqual({ running: true, lastRegenerateAt: null, runsToday: 2, latestPreparedAt: "2026-11-12T10:00:00Z", lastAttemptAt: "2026-11-12T10:00:00Z" });
    expect(state.requireRole).toHaveBeenLastCalledWith("PKG", ["owner"]);
    state.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await briefingRunState("PKG")).toBeNull();
    state.requireRole.mockRejectedValueOnce(new AuthError("forbidden" as never));
    expect(await briefingRunState("PKG")).toBeNull();
    expect(await briefingRunState("bad lane")).toBeNull();
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "x" } });
    expect(await briefingRunState("PKG")).toBeNull();
  });
});
