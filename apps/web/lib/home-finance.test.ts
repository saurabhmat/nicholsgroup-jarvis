// T-233: mapping, formatting and empty states of the Home finance cards. Figures are only formatted here (rule 7); the
// numbers below are synthetic (rule 10). Never a sample number for an empty state.
import { describe, expect, it, vi } from "vitest";
import { connectionNote, emptyStateText, financeCards, formatAsOf, formatMoney, formatMonth, hasFinanceView, homeFinanceFor, loadHomeFinance, toHomeFinance, type HomeFinanceView } from "./home-finance";

const okRow = {
  state: "ok",
  as_of: "2026-11-11T20:00:00Z",
  last_sync_at: "2026-11-11T19:55:00Z",
  connection_status: "active",
  business_date: "2026-11-11",
  cash_reason: null,
  cash_total: 1314.66,
  cash_as_of: "2026-11-10T20:00:00Z",
  cash_accounts: [
    { name: "Operating", book_balance: 1234.56, shared: false },
    { name: "Reserve", book_balance: -20, shared: true },
  ],
  cash_unmapped: 1,
  ar_reason: null,
  ar_over_30: 160.25,
  ar_invoices: 3,
  ar_unmapped: 0,
  pnl_reason: null,
  pnl_income: 1260.5,
  pnl_expenses: 505.25,
  pnl_net: 755.25,
  pnl_start: "2026-11-01",
  pnl_end: "2026-11-11",
  pnl_method: "accrual",
  pnl_partial: true,
  pnl_as_of: "2026-11-11T19:50:00Z",
};
const ok = (over: Record<string, unknown> = {}) => toHomeFinance([{ ...okRow, ...over }]);
type Shown = Exclude<HomeFinanceView, { state: "no_access" }>;
const empty = (state: string, over: Record<string, unknown> = {}) =>
  toHomeFinance([{ state, as_of: null, last_sync_at: null, connection_status: null, cash_accounts: [], cash_unmapped: 0, ar_invoices: 0, ar_unmapped: 0, pnl_partial: false, ...over }]);

describe("formatting", () => {
  it("money has the dollar sign, thousands separators, two decimals and a minus for negatives", () => {
    expect(formatMoney(1314.66)).toBe("$1,314.66");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-20)).toBe("-$20.00");
    expect(formatMoney(1234567.5)).toBe("$1,234,567.50");
  });
  it("as-of is in New York time, with ET", () => {
    expect(formatAsOf("2026-11-11T20:00:00Z")).toBe("Nov 11, 3:00 PM ET");
    expect(formatAsOf("2026-07-01T20:00:00Z")).toBe("Jul 1, 4:00 PM ET");
  });
  it("a calendar date gives its month without a time-zone shift", () => {
    expect(formatMonth("2026-11-01")).toBe("November 2026");
  });
});

describe("toHomeFinance", () => {
  it("maps the row; numerics may arrive as numbers or strings", () => {
    const v = ok({ cash_total: "1314.66", ar_over_30: "160.25" });
    expect(v.state).toBe("ok");
    if (v.state !== "ok") return;
    expect(v.cash.total).toBe(1314.66);
    expect(v.ar.over30).toBe(160.25);
    expect(v.cash.accounts).toEqual([
      { name: "Operating", bookBalance: 1234.56, shared: false },
      { name: "Reserve", bookBalance: -20, shared: true },
    ]);
    expect(v.pnl.partial).toBe(true);
  });
  it("no row, an unknown state or garbage fails closed to no_access (nothing shown)", () => {
    expect(toHomeFinance([])).toEqual({ state: "no_access" });
    expect(toHomeFinance(null)).toEqual({ state: "no_access" });
    expect(toHomeFinance([{ state: "weird" }])).toEqual({ state: "no_access" });
    expect(toHomeFinance([{ state: "no_access", cash_total: 99 }])).toEqual({ state: "no_access" });
  });
  it("non-numeric figures become null, never NaN or 0", () => {
    const v = ok({ cash_total: "abc", ar_over_30: NaN, pnl_net: undefined });
    if (v.state !== "ok") throw new Error("state");
    expect([v.cash.total, v.ar.over30, v.pnl.net]).toEqual([null, null, null]);
  });
});

describe("empty states", () => {
  it("not connected: Connect QuickBooks in Settings, on all three cards, with the link", () => {
    const cards = financeCards(empty("not_connected"));
    expect(cards.map((c) => c.label)).toEqual(["Cash", "AR > 30 days", "P&L month to date"]);
    expect(cards.every((c) => c.statusText === "Connect QuickBooks in Settings" && c.connectLink && c.value === undefined)).toBe(true);
    expect(cards[0]?.bookBalance).toBe(true);
  });
  it("connected but no data: says so with the last sync time, or 'not synced yet'", () => {
    expect(emptyStateText(empty("no_data", { last_sync_at: "2026-11-11T20:00:00Z" }) as Shown)).toBe("No QuickBooks data yet (last sync Nov 11, 3:00 PM ET)");
    expect(emptyStateText(empty("no_data") as Shown)).toBe("No QuickBooks data yet (not synced yet)");
    expect(financeCards(empty("no_data")).every((c) => c.value === undefined && !c.connectLink)).toBe(true);
  });
  it("mapping missing says so", () => {
    expect(financeCards(empty("mapping_missing"))[0]?.statusText).toMatch(/entity mapping is missing/);
  });
  it("no access: no cards at all", () => {
    expect(financeCards({ state: "no_access" })).toEqual([]);
  });
  it("unavailable: its own text, and no figures", () => {
    expect(emptyStateText({ state: "unavailable" })).toMatch(/Could not load QuickBooks figures/);
  });
  it("an empty state never carries a number", () => {
    for (const s of ["not_connected", "no_data", "mapping_missing"]) {
      for (const c of financeCards(empty(s))) expect(c.value).toBeUndefined();
    }
  });
});

describe("cards with figures", () => {
  const cards = financeCards(ok());
  const [cash, ar, pnl] = cards;

  it("Cash: Book balance label, total, unmapped caveat, its own as-of", () => {
    expect(cash?.bookBalance).toBe(true);
    expect(cash?.value).toBe("$1,314.66");
    expect(cash?.flags).toEqual(["Excludes 1 unmapped account"]);
    expect(cash?.asOf).toBe("As of Nov 10, 3:00 PM ET");
  });
  it("AR > 30: figure, no caveat when all invoices have a company, as-of is the sync's", () => {
    expect(ar?.value).toBe("$160.25");
    expect(ar?.flags).toEqual([]);
    expect(financeCards(ok({ ar_unmapped: 2 }))[1]?.flags).toEqual(["Excludes 2 invoices with no company"]);
    expect(ar?.asOf).toBe("As of Nov 11, 3:00 PM ET");
  });
  it("P&L: net with the month and the payroll caveat", () => {
    expect(pnl?.value).toBe("$755.25");
    expect(pnl?.qualifier).toBe("Net, November 2026");
    expect(pnl?.flags).toEqual(["Excludes payroll accounts"]);
  });
  it("a zero AR is a real figure, not an empty state", () => {
    const v = ok({ ar_over_30: 0, ar_invoices: 0 });
    expect(financeCards(v)[1]?.value).toBe("$0.00");
  });
  it("a figure with a reason shows the reason, not the number (other cards unaffected)", () => {
    const v = ok({ cash_reason: "balance_sheet_not_cached", cash_total: null, pnl_reason: "month_report_not_cached", pnl_net: null, pnl_income: null, pnl_expenses: null });
    const [c, a, p] = financeCards(v);
    expect(c?.value).toBeUndefined();
    expect(c?.statusText).toBe("The balance sheet is not part of the QuickBooks sync yet");
    expect(c?.bookBalance).toBe(true);
    expect(a?.value).toBe("$160.25");
    expect(p?.statusText).toBe("The month-to-date report is not synced yet");
  });
  it("an unknown reason still shows a text and never a figure", () => {
    const v = ok({ ar_reason: "something_new", ar_over_30: 5 });
    const ar = financeCards(v)[1];
    expect(ar?.statusText).toBe("Not available yet");
    expect(ar?.value).toBeUndefined();
  });
  it("the Book balance label is the only cash wording: no 'bank balance'", () => {
    expect(JSON.stringify(cards).toLowerCase()).not.toContain("bank balance");
  });
});

describe("connectionNote", () => {
  it("warns when the connection needs reconnecting or has problems", () => {
    expect(connectionNote(ok({ connection_status: "reconnect_required" }))).toMatch(/needs reconnecting/);
    expect(connectionNote(ok({ connection_status: "degraded" }))).toMatch(/has problems/);
    expect(connectionNote(ok())).toBeNull();
    expect(connectionNote({ state: "unavailable" })).toBeNull();
  });
});

describe("loading", () => {
  it("calls core.home_finance with the lane and maps the row", async () => {
    const rpc = vi.fn(async () => ({ data: [okRow], error: null }));
    const schema = vi.fn(() => ({ rpc }));
    const v = await loadHomeFinance({ schema } as never, "PKG");
    expect(schema).toHaveBeenCalledWith("core");
    expect(rpc).toHaveBeenCalledWith("home_finance", { p_lane: "PKG" });
    expect(v.state).toBe("ok");
  });
  it("an error throws; homeFinanceFor turns any failure into `unavailable` without leaking the message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { schema: () => ({ rpc: async () => ({ data: null, error: { message: "password=synthetic" } }) }) } as never;
    await expect(loadHomeFinance(client, "PKG")).rejects.toThrow("finance unavailable");
    expect(await homeFinanceFor({ requireLane: async () => ({ client }) as never }, "PKG")).toEqual({ state: "unavailable" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("password");
    errors.mockRestore();
  });
  it("a lane the caller may not use is `unavailable` too (the page gate runs first, so this is only a fallback)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await homeFinanceFor({ requireLane: async () => Promise.reject(new Error("forbidden")) } as never, "APK")).toEqual({ state: "unavailable" });
    errors.mockRestore();
  });
});

describe("hasFinanceView (T-237 review: outage shown only to the finance view)", () => {
  const g = (data: unknown, error: unknown = null, calls: unknown[] = []) =>
    ({ requireLane: async () => ({ client: { schema: () => ({ rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return { data, error }; } }) }, session: { userId: "u1" } }) }) as never;
  it("true only when the lane is in the caller's allowed lanes for the finance view", async () => {
    const calls: unknown[] = [];
    expect(await hasFinanceView(g(["PKG"], null, calls), "PKG")).toBe(true);
    expect(calls).toEqual([["allowed_lanes", { p_uid: "u1", p_view: "finance" }]]);
    expect(await hasFinanceView(g([]), "PKG")).toBe(false);
    expect(await hasFinanceView(g(["NLG"]), "PKG")).toBe(false);
  });
  it("fails closed on an error or a throw", async () => {
    expect(await hasFinanceView(g(["PKG"], { message: "x" }), "PKG")).toBe(false);
    expect(await hasFinanceView({ requireLane: async () => { throw new Error("x"); } } as never, "PKG")).toBe(false);
  });
});
