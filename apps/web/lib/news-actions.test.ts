// T-234 part 4: the Refresh server action. Owner only (the guard is asked for the owner role and nothing else), the lane id is
// checked first, the AI must be configured, SQL gate refusals become codes (rate limit, cap), a success revalidates Home.
// T-249: the reservation runs in the action; the fetch runs in after() (the action answers "started" at once), 240 s bound.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createMockProvider, webSearchResult } from "@nichols/ai/testing";

const state = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn(), provider: vi.fn(), revalidate: vi.fn(), after: vi.fn(), renew: vi.fn() }));
vi.mock("@/lib/guards", () => ({
  renewSessionFor: (s: number) => state.renew(s),
  guards: async () => ({
    requireRole: state.requireRole,
    listLanes: async () => [{ laneId: "PKG", name: "Pub K" }],
  }),
}));
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: (...a: unknown[]) => state.provider(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => state.revalidate(p) }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => state.after(fn) }));
import { refreshNews } from "@/app/[laneId]/news-actions";
import { NEWS_CALL_TIMEOUT_MS, NEWS_FETCH_TIMEOUT_MS } from "@/lib/news-types";

/** Runs the work handed to after() (as Next does once the response is sent). */
const runAfter = async () => {
  for (const [fn] of state.after.mock.calls as [() => Promise<void>][]) await fn();
};

const client = () => ({
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { news: { enabled: true } } }, error: null }) }) }) }),
    rpc: (fn: string, args: unknown) => state.rpc(fn, args),
  }),
});
const ok = () => webSearchResult({ text: JSON.stringify({ items: [{ headline: "H", why: "W", source_name: "S", source_url: "https://a.gov/x", published_at: null }] }), hits: [{ url: "https://a.gov/x" }] });

beforeEach(() => {
  vi.clearAllMocks();
  state.requireRole.mockResolvedValue({ client: client(), session: { userId: "u", expiresAt: Math.floor(Date.now() / 1000) + 900 } });
  state.renew.mockResolvedValue("fresh");
  state.rpc.mockImplementation(async (fn: string) => (fn === "news_begin_refresh" ? { data: { id: "id-1", gate: null }, error: null } : { data: null, error: null }));
  state.provider.mockReturnValue({ configured: true, provider: createMockProvider([ok()]) });
  state.after.mockImplementation(() => undefined);
});

describe("refreshNews", () => {
  it("asks for the owner role only; a non-owner gets forbidden and nothing runs", async () => {
    state.requireRole.mockRejectedValueOnce(new AuthError("forbidden" as never));
    expect(await refreshNews("PKG")).toEqual({ error: "forbidden" });
    expect(state.rpc).not.toHaveBeenCalled();
    state.requireRole.mockResolvedValueOnce({ client: client(), session: { userId: "u" } });
    await refreshNews("PKG");
    expect(state.requireRole).toHaveBeenLastCalledWith("PKG", ["owner"]);
  });
  it("refuses a malformed lane id before any guard or call", async () => {
    expect(await refreshNews("pkg; drop")).toEqual({ error: "forbidden" });
    expect(await refreshNews(5 as never)).toEqual({ error: "forbidden" });
    expect(state.requireRole).not.toHaveBeenCalled();
  });
  it("AI not configured: a code, no reservation", async () => {
    state.provider.mockReturnValue({ configured: false, missing: [], refused: [] });
    expect(await refreshNews("PKG")).toEqual({ error: "ai_not_set_up" });
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("scheduled-only gate codes cannot reach the owner as anything but busy", async () => {
    for (const code of ["retry_later", "attempts_exhausted", "already_fetched"]) {
      state.provider.mockReturnValue({ configured: true, provider: createMockProvider([ok()]) });
      state.rpc.mockResolvedValueOnce({ data: { id: null, gate: code }, error: null });
      expect(await refreshNews("PKG")).toEqual({ error: "busy" });
    }
  });
  it("T-249: the fetch is bounded at 240 s with 150 s per request (Home's maxDuration is 300 s, SQL calls a pending row lost after 10 min)", () => {
    expect(NEWS_FETCH_TIMEOUT_MS).toBe(240_000);
    expect(NEWS_CALL_TIMEOUT_MS).toBe(150_000);
    expect(NEWS_FETCH_TIMEOUT_MS).toBeLessThan(300_000 - 30_000);
  });
  it("the SQL refusals (1 per hour, monthly cap, not configured) are returned as codes and the model is never called", async () => {
    for (const code of ["rate_limited", "cap_reached", "not_configured", "busy"]) {
      const provider = createMockProvider([ok()]);
      state.provider.mockReturnValue({ configured: true, provider });
      state.rpc.mockResolvedValueOnce({ data: { id: null, gate: code }, error: null });
      expect(await refreshNews("PKG")).toEqual({ error: code });
      expect(provider.calls).toHaveLength(0);
      expect(state.after).not.toHaveBeenCalled();
    }
  });
  it("T-249: reserves in the action, answers 'started' at once and runs the fetch in after(), not inline", async () => {
    const provider = createMockProvider([ok()]);
    state.provider.mockReturnValue({ configured: true, provider });
    expect(await refreshNews("PKG")).toEqual({ ok: true, status: "started" });
    expect(state.rpc.mock.calls.map((c) => c[0])).toEqual(["news_begin_refresh"]);
    expect(provider.calls).toHaveLength(0);
    expect(state.after).toHaveBeenCalledTimes(1);
    expect(state.revalidate).toHaveBeenCalledWith("/PKG");
  });
  it("T-249 (security H1): the session is renewed first when needed (300 s = fetch bound + 60 s); a token that still cannot outlive the fetch reserves nothing", async () => {
    await refreshNews("PKG");
    expect(state.renew).toHaveBeenCalledWith(300);
    expect(state.renew.mock.invocationCallOrder[0]).toBeLessThan(state.requireRole.mock.invocationCallOrder[0] ?? 0);
    vi.clearAllMocks();
    state.renew.mockResolvedValue("failed");
    for (const session of [{ userId: "u", expiresAt: Math.floor(Date.now() / 1000) + 120 }, { userId: "u" }]) {
      state.requireRole.mockResolvedValueOnce({ client: client(), session });
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await refreshNews("PKG")).toEqual({ error: "unavailable" });
      err.mockRestore();
    }
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.after).not.toHaveBeenCalled();
  });
  it("the background run stores via the owner's own function (no service client) for the reserved id, no retries on the SDK", async () => {
    await refreshNews("PKG");
    await runAfter();
    expect(state.rpc.mock.calls.map((c) => c[0])).toEqual(["news_begin_refresh", "news_finish_own"]);
    expect(state.rpc.mock.calls[1]?.[1]).toMatchObject({ p_lane: "PKG", p_id: "id-1", p_status: "partial" });
    expect(state.provider).toHaveBeenCalledWith({ timeoutMs: 150_000, maxRetries: 0 });
  });
  it("a fault inside the background run is logged by class only and never thrown (SQL closes the row as lost)", async () => {
    state.rpc.mockImplementation(async (fn: string) => (fn === "news_begin_refresh" ? { data: { id: "id-1", gate: null }, error: null } : { data: null, error: { message: "secret detail", code: "XX000" } }));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await refreshNews("PKG");
    await expect(runAfter()).resolves.toBeUndefined();
    expect(JSON.stringify(err.mock.calls)).not.toContain("secret detail");
    err.mockRestore();
  });
  it("a store failure is reported as unavailable, never with SQL detail", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "relation x does not exist: secret", code: "42P01" } });
    expect(await refreshNews("PKG")).toEqual({ error: "unavailable" });
  });
});
