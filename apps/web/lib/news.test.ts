import { describe, expect, it, vi } from "vitest";
import { webSearchResult, createMockProvider } from "@nichols/ai/testing";
import { beginNews, finishNews, itemsFrom, loadNewsCard } from "./news";
import { NewsGateError } from "./news-run";
import { newsFailureText } from "./news-types";

const NOW = new Date("2026-11-12T15:00:00Z");
type Res = { data: unknown; error: unknown };
function fake(rpc: Record<string, Res>, config: unknown = { news: { enabled: true } }) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    schema: () => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config }, error: null }) }) }) }),
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return rpc[fn] ?? { data: null, error: { message: "missing" } };
      },
    }),
  } as never;
  return { client, calls };
}
const item = (over: Record<string, unknown> = {}) => ({ headline: "H", why: "W", source_name: "S", source_url: "https://a.gov/x", published_at: "2026-11-12T09:00:00Z", citations: [], ...over });

describe("begin / finish", () => {
  it("refresh uses the owner functions and the schedule uses the job functions", async () => {
    const f = fake({ news_begin_refresh: { data: "id-r", error: null }, news_begin_scheduled: { data: "id-s", error: null } });
    expect(await beginNews(f.client, "PKG", "refresh", 0.8)).toBe("id-r");
    expect(await beginNews(f.client, "PKG", "schedule", 0.8)).toBe("id-s");
    expect(f.calls.map((c) => c.fn)).toEqual(["news_begin_refresh", "news_begin_scheduled"]);
    expect(f.calls[0]?.args).toEqual({ p_lane: "PKG", p_reserve: 0.8 });
  });
  it("the SQL refusal messages become gate errors (rate limit and cap mapping); anything else is an infrastructure error", async () => {
    for (const m of ["rate_limited", "cap_reached", "not_configured", "busy", "already_fetched"]) {
      await expect(beginNews(fake({ news_begin_refresh: { data: null, error: { message: m, code: "P0001" } } }).client, "PKG", "refresh", 1)).rejects.toBeInstanceOf(NewsGateError);
    }
    await expect(beginNews(fake({ news_begin_refresh: { data: null, error: { message: "permission denied for table x", code: "42501" } } }).client, "PKG", "refresh", 1)).rejects.toThrow("news begin failed (42501)");
  });
  it("finish passes the lane and the exact result; its error text never carries SQL detail", async () => {
    const f = fake({ news_finish_own: { data: null, error: null }, news_finish: { data: null, error: { message: "secret detail", code: "23514" } } });
    await finishNews(f.client, "PKG", "refresh", "id", { status: "ok", failureCode: null, items: [], searches: 2, estCostUsd: 0.3 });
    expect(f.calls[0]).toMatchObject({ fn: "news_finish_own", args: { p_lane: "PKG", p_id: "id", p_status: "ok", p_searches: 2, p_est_cost: 0.3 } });
    await expect(finishNews(f.client, "PKG", "schedule", "id", { status: "failed", failureCode: "model_failed", items: [], searches: 0, estCostUsd: 0 })).rejects.toThrow("news finish failed (23514)");
  });
});

describe("itemsFrom (stored rows are validated again on read)", () => {
  it("keeps https items, drops the rest, never more than 6", () => {
    const rows = [item(), item({ source_url: "http://a.gov/x" }), item({ source_url: "javascript:alert(1)" }), item({ headline: "" }), "x", null, ...Array.from({ length: 8 }, (_, i) => item({ source_url: `https://a.gov/${String(i)}` }))];
    const out = itemsFrom(rows);
    expect(out).toHaveLength(6);
    expect(out.every((i) => i.url.startsWith("https://"))).toBe(true);
    expect(itemsFrom("nope")).toEqual([]);
  });
  it("text is re-flattened to plain text", () => {
    expect(itemsFrom([item({ headline: "<b>Bold</b> [x](https://e.test)" })])[0]?.headline).toBe("Bold x");
  });
});

describe("loadNewsCard (reads only)", () => {
  const latest = (over: Record<string, unknown> = {}) => ({ data: [{ items: [item()], fetched_at: "2026-11-12T11:00:00Z", last_failed_at: null, last_failure_code: null, last_refresh_at: null, pending_since: null, ...over }], error: null });
  it("not configured: no items, no refresh", async () => {
    const f = fake({ news_enabled: { data: false, error: null }, news_latest: { data: [], error: null } });
    const c = await loadNewsCard(f.client, "PKG", { isOwner: true, isAdmin: true }, NOW);
    expect(c).toMatchObject({ configured: false, items: [], canRefresh: false, updatedAt: null });
  });
  it("configured owner: items, updated time, refresh allowed; reads never call a begin function", async () => {
    const f = fake({ news_enabled: { data: true, error: null }, news_latest: latest(), news_spend: { data: [{ month_spend: 1, cap_usd: 20 }], error: null } });
    const c = await loadNewsCard(f.client, "PKG", { isOwner: true, isAdmin: true }, NOW);
    expect(c).toMatchObject({ configured: true, canRefresh: true, updatedAt: "2026-11-12T11:00:00Z", nextRefreshAt: null, budgetReached: false });
    expect(c.items).toHaveLength(1);
    expect(f.calls.map((x) => x.fn).sort()).toEqual(["news_enabled", "news_latest", "news_spend"]);
    expect(f.calls.some((x) => /begin|finish/.test(x.fn))).toBe(false);
  });
  it("a viewer sees items but cannot refresh and does not read the spend", async () => {
    const f = fake({ news_enabled: { data: true, error: null }, news_latest: latest() });
    const c = await loadNewsCard(f.client, "PKG", { isOwner: false, isAdmin: false }, NOW);
    expect(c).toMatchObject({ configured: true, canRefresh: false, budgetReached: false });
    expect(f.calls.some((x) => x.fn === "news_spend")).toBe(false);
  });
  it("the 1-per-hour limit becomes a time; past it, nothing", async () => {
    const f = fake({ news_enabled: { data: true, error: null }, news_latest: latest({ last_refresh_at: "2026-11-12T14:30:00Z" }), news_spend: { data: [{ month_spend: 0, cap_usd: 20 }], error: null } });
    expect((await loadNewsCard(f.client, "PKG", { isOwner: true, isAdmin: true }, NOW)).nextRefreshAt).toBe("2026-11-12T15:30:00.000Z");
    const g = fake({ news_enabled: { data: true, error: null }, news_latest: latest({ last_refresh_at: "2026-11-12T13:59:00Z" }), news_spend: { data: [{ month_spend: 0, cap_usd: 20 }], error: null } });
    expect((await loadNewsCard(g.client, "PKG", { isOwner: true, isAdmin: true }, NOW)).nextRefreshAt).toBeNull();
  });
  it("budget reached when month-to-date + the worst case of one fetch exceeds the cap", async () => {
    const f = fake({ news_enabled: { data: true, error: null }, news_latest: latest(), news_spend: { data: [{ month_spend: "19.50", cap_usd: "20" }], error: null } });
    expect((await loadNewsCard(f.client, "PKG", { isOwner: true, isAdmin: true }, NOW)).budgetReached).toBe(true);
  });
  it("shows the newest failure code after the digest and the in-flight flag; unreadable data is the empty state", async () => {
    const f = fake({ news_enabled: { data: true, error: null }, news_latest: latest({ last_failed_at: "2026-11-12T12:00:00Z", last_failure_code: "model_busy", pending_since: "2026-11-12T14:59:00Z" }) });
    expect(await loadNewsCard(f.client, "PKG", { isOwner: false, isAdmin: false }, NOW)).toMatchObject({ failure: "model_busy", inFlight: true });
    const bad = fake({ news_enabled: { data: null, error: { message: "x" } }, news_latest: { data: null, error: { message: "x" } } });
    expect(await loadNewsCard(bad.client, "PKG", { isOwner: true, isAdmin: true }, NOW)).toMatchObject({ configured: false, items: [] });
  });
});

describe("failure texts", () => {
  it("are fixed; an unknown code gets a generic reason, never the raw code", () => {
    expect(newsFailureText("model_busy")).toBe("the AI service was busy");
    expect(newsFailureText("<script>")).toBe("an unexpected error");
    expect(newsFailureText(null)).toBe("an unexpected error");
  });
});

// The scheduled path (job client injected).
vi.mock("@nichols/ai/config", () => ({ getLLMProvider: vi.fn() }));
describe("scheduled news", () => {
  it("newsDue: config on and time reached; off or early is not due", async () => {
    const { newsDue } = await import("./news-schedule");
    const c = (config: unknown) => async () => fake({}, config).client;
    expect(await newsDue(c({ news: { enabled: true, time: "06:00" } }), "PKG", new Date("2026-11-12T12:00:00Z"))).toBe(true);
    expect(await newsDue(c({ news: { enabled: true, time: "06:00" } }), "PKG", new Date("2026-11-12T10:00:00Z"))).toBe(false);
    expect(await newsDue(c({}), "PKG", new Date("2026-11-12T12:00:00Z"))).toBe(false);
  });
  it("runScheduledNews: no AI -> skipped; a SQL gate refusal -> skipped with its code; success -> fetched; per-lane config", async () => {
    const { runScheduledNews } = await import("./news-schedule");
    const { getLLMProvider } = await import("@nichols/ai/config");
    const mocked = vi.mocked(getLLMProvider);
    mocked.mockReturnValue({ configured: false, missing: ["ANTHROPIC_API_KEY"], refused: [] } as never);
    expect(await runScheduledNews(async () => fake({}).client, "PKG", NOW)).toBe("skipped:ai_not_set_up");

    const provider = createMockProvider([webSearchResult({ text: JSON.stringify({ items: [{ headline: "H", why: "W", source_name: "S", source_url: "https://a.gov/x", published_at: null }] }), hits: [{ url: "https://a.gov/x" }] })]);
    mocked.mockReturnValue({ configured: true, provider } as never);
    const capped = fake({ news_begin_scheduled: { data: null, error: { message: "cap_reached", code: "P0001" } } });
    expect(await runScheduledNews(async () => capped.client, "PKG", NOW)).toBe("skipped:cap_reached");
    expect(provider.calls).toHaveLength(0);
    const ok = fake({ news_begin_scheduled: { data: "id-1", error: null }, news_finish: { data: null, error: null } });
    expect(await runScheduledNews(async () => ok.client, "PKG", NOW)).toBe("fetched");
    expect(ok.calls.map((x) => x.fn)).toEqual(["news_begin_scheduled", "news_finish"]);
    expect((ok.calls[0]?.args as { p_lane: string }).p_lane).toBe("PKG");
    // a model failure is stored (not thrown) and reported with its code
    const failing = createMockProvider([new (await import("@nichols/ai")).LLMProviderError("rate_limited")]);
    mocked.mockReturnValue({ configured: true, provider: failing } as never);
    const f2 = fake({ news_begin_scheduled: { data: "id-2", error: null }, news_finish: { data: null, error: null } });
    expect(await runScheduledNews(async () => f2.client, "PKG", NOW)).toBe("failed:model_busy");
    // an infrastructure fault throws (the job reports the lane)
    const broken = fake({ news_begin_scheduled: { data: null, error: { message: "boom", code: "XX000" } } });
    await expect(runScheduledNews(async () => broken.client, "PKG", NOW)).rejects.toThrow("news begin failed");
  });
});
