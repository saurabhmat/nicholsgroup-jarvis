// T-234 part 4: the Refresh server action. Owner only (the guard is asked for the owner role and nothing else), the lane id is
// checked first, the AI must be configured, SQL gate refusals become codes (rate limit, cap), a success revalidates Home.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { createMockProvider, webSearchResult } from "@nichols/ai/testing";

const state = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn(), provider: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/guards", () => ({
  guards: async () => ({
    requireRole: state.requireRole,
    listLanes: async () => [{ laneId: "PKG", name: "Pub K" }],
  }),
}));
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: (...a: unknown[]) => state.provider(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => state.revalidate(p) }));
import { refreshNews } from "@/app/[laneId]/news-actions";

const client = () => ({
  schema: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: { news: { enabled: true } } }, error: null }) }) }) }),
    rpc: (fn: string, args: unknown) => state.rpc(fn, args),
  }),
});
const ok = () => webSearchResult({ text: JSON.stringify({ items: [{ headline: "H", why: "W", source_name: "S", source_url: "https://a.gov/x", published_at: null }] }), hits: [{ url: "https://a.gov/x" }] });

beforeEach(() => {
  vi.clearAllMocks();
  state.requireRole.mockResolvedValue({ client: client(), session: { userId: "u" } });
  state.rpc.mockImplementation(async (fn: string) => (fn === "news_begin_refresh" ? { data: "id-1", error: null } : { data: null, error: null }));
  state.provider.mockReturnValue({ configured: true, provider: createMockProvider([ok()]) });
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
  it("the SQL refusals (1 per hour, monthly cap, not configured) are returned as codes and the model is never called", async () => {
    for (const code of ["rate_limited", "cap_reached", "not_configured", "busy"]) {
      const provider = createMockProvider([ok()]);
      state.provider.mockReturnValue({ configured: true, provider });
      state.rpc.mockResolvedValueOnce({ data: null, error: { message: code, code: "P0001" } });
      expect(await refreshNews("PKG")).toEqual({ error: code });
      expect(provider.calls).toHaveLength(0);
    }
  });
  it("a successful refresh stores via the owner's own function (no service client), revalidates Home, no retries on the SDK", async () => {
    expect(await refreshNews("PKG")).toEqual({ ok: true, status: "partial" });
    expect(state.rpc.mock.calls.map((c) => c[0])).toEqual(["news_begin_refresh", "news_finish_own"]);
    expect(state.revalidate).toHaveBeenCalledWith("/PKG");
    expect(state.provider).toHaveBeenCalledWith({ timeoutMs: 60_000, maxRetries: 0 });
  });
  it("a store failure is reported as unavailable, never with SQL detail", async () => {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "relation x does not exist: secret", code: "42P01" } });
    expect(await refreshNews("PKG")).toEqual({ error: "unavailable" });
  });
});
