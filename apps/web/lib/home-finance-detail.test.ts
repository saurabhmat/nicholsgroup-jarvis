// T-237 part B/C: mapping of core.home_finance_detail. Synthetic figures only.
import { describe, expect, it, vi } from "vitest";
import { barWidths, homeFinanceDetailFor, toHomeFinanceDetail } from "./home-finance-detail";

const aging = [
  { bucket: "current", total: "100.00", count: 2 },
  { bucket: "1_30", total: 50, count: 1 },
  { bucket: "31_60", total: 0, count: 0 },
  { bucket: "61_90", total: 25.5, count: 1 },
  { bucket: "90_plus", total: 10, count: 1 },
];
const row = { state: "ok", as_of: "2026-11-11T20:00:00Z", bills_due_14_total: "410.50", bills_due_14_count: 2, aging, oldest: [{ customer: "Customer A", balance: 10, days_overdue: 94 }, { customer: null, balance: "5.00", days_overdue: 71 }], unmapped_invoices: 1, unmapped_bills: 0 };

describe("toHomeFinanceDetail", () => {
  it("maps the row; numerics may be strings; the customer may be null", () => {
    const v = toHomeFinanceDetail([row]);
    expect(v.state).toBe("ok");
    if (v.state !== "ok") return;
    expect(v.bills).toEqual({ total: 410.5, count: 2 });
    expect(v.aging.map((a) => [a.bucket, a.total, a.count])).toEqual([["current", 100, 2], ["1_30", 50, 1], ["31_60", 0, 0], ["61_90", 25.5, 1], ["90_plus", 10, 1]]);
    expect(v.oldest).toEqual([{ customer: "Customer A", balance: 10, daysOverdue: 94 }, { customer: null, balance: 5, daysOverdue: 71 }]);
    expect(v.unmappedInvoices).toBe(1);
    expect(v.asOf).toBe("2026-11-11T20:00:00.000Z");
  });
  it("fails closed: no row, unknown state or no_access give no_access", () => {
    expect(toHomeFinanceDetail(null)).toEqual({ state: "no_access" });
    expect(toHomeFinanceDetail([])).toEqual({ state: "no_access" });
    expect(toHomeFinanceDetail([{ state: "weird" }])).toEqual({ state: "no_access" });
    expect(toHomeFinanceDetail([{ state: "no_access" }])).toEqual({ state: "no_access" });
  });
  it("an incomplete aging array gives no chart, junk oldest rows are dropped, at most three are kept", () => {
    const v = toHomeFinanceDetail([{ ...row, aging: aging.slice(0, 4), oldest: [{ balance: "x", days_overdue: 4 }, { balance: 1, days_overdue: 0 }, ...Array.from({ length: 5 }, () => ({ customer: "C", balance: 1, days_overdue: 9 }))] }]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.aging).toEqual([]);
    expect(v.oldest).toHaveLength(1); // only the first three rows are read; two of them are junk
  });
  it("a not-connected row has no figures", () => {
    const v = toHomeFinanceDetail([{ state: "not_connected", as_of: null, bills_due_14_total: null, bills_due_14_count: null, aging: [], oldest: [], unmapped_invoices: 0, unmapped_bills: 0 }]);
    expect(v).toMatchObject({ state: "not_connected", bills: { total: null, count: 0 }, aging: [], oldest: [] });
  });
});

describe("barWidths (display only)", () => {
  it("scales to the largest, zero and negative get 0, tiny positives get a visible minimum", () => {
    expect(barWidths([100, 50, 0, -5, 0.1])).toEqual([100, 50, 0, 0, 2]);
    expect(barWidths([0, 0])).toEqual([0, 0]);
  });
});

describe("homeFinanceDetailFor", () => {
  it("returns unavailable when the read throws (never an invented figure)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const g = { requireLane: async () => ({ client: {} }) } as never;
    expect(await homeFinanceDetailFor(g, "PKG", async () => { throw new Error("x"); })).toEqual({ state: "unavailable" });
  });
});

describe("oldest unpaid invoices mapper (T-237 review)", () => {
  it("excludes rows with fewer than one day overdue (0, a fraction, negative) and keeps whole days", () => {
    // (only the first three rows are read)
    const none = toHomeFinanceDetail([{ ...row, oldest: [{ customer: "A", balance: 1, days_overdue: 0 }, { customer: "B", balance: 1, days_overdue: 0.9 }, { customer: "C", balance: 1, days_overdue: -3 }] }]);
    expect(none.state === "ok" && none.oldest).toEqual([]);
    const v = toHomeFinanceDetail([{ ...row, oldest: [{ customer: "A", balance: 1, days_overdue: 0 }, { customer: "D", balance: 2, days_overdue: 1 }, { customer: "E", balance: 3, days_overdue: "7.8" }] }]);
    expect(v.state === "ok" && v.oldest).toEqual([{ customer: "D", balance: 2, daysOverdue: 1 }, { customer: "E", balance: 3, daysOverdue: 7 }]);
  });
});
