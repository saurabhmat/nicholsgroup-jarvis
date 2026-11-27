// T-300, T-301: mapping of core.finance_receivables, core.finance_weekly and core.finance_week_detail, the loaders' guards and the
// `?week=` parameter. Synthetic figures only (rule 10). The mappers copy SQL's figures; nothing is added here.
import { describe, expect, it, vi } from "vitest";
import { FINANCE_TABS, financeWeeklyFor, loadFinanceWeekly, loadReceivables, loadWeekDetail, parseWeek, receivablesFor, toFinanceWeekly, toReceivables, toWeekDetail, weekDetailFor } from "./finance-reports";

const buckets = [
  { bucket: "current", total: 51.06, count: 2 }, { bucket: "1_30", total: 0, count: 0 }, { bucket: "31_60", total: "210.20", count: 2 }, { bucket: "61_90", total: 0, count: 0 }, { bucket: "90_plus", total: 100.1, count: 1 },
];
const cust = (over: Record<string, unknown> = {}) => ({
  name: "Alpha Co", current: 0, "1_30": 0, "31_60": 200.2, "61_90": 0, "90_plus": 100.1, total: 300.3, invoices: 2, detail_shown: 2,
  detail: [{ issue_date: "2026-08-01", due_date: "2026-08-06", days_overdue: 95, balance: 100.1 }, { issue_date: "2026-10-01", due_date: null, days_overdue: 40, balance: 200.2 }], ...over,
});
const arRow = (over: Record<string, unknown> = {}) => ({
  state: "ok", as_of: "2026-11-27T15:00:00Z", last_sync_at: "2026-11-27T14:55:00Z", connection_status: "active", business_date: "2026-11-27", buckets, total: 361.36, invoice_count: 5,
  customers: [cust(), cust({ name: null, total: 1.01, invoices: 1, detail_shown: 1, detail: [] })], customer_count: 3, customers_shown: 2, customer_cap: 50, invoice_cap: 25,
  check_reason: null, check_total: 360, check_report_date: "2026-11-27", check_difference: 1.36, ...over,
});

describe("toReceivables", () => {
  it("maps the row: buckets, customers with their detail, caps and the check", () => {
    const v = toReceivables([arRow()]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.buckets.map((b) => [b.bucket, b.total, b.count])).toEqual([["current", 51.06, 2], ["1_30", 0, 0], ["31_60", 210.2, 2], ["61_90", 0, 0], ["90_plus", 100.1, 1]]);
    expect(v.total).toBe(361.36);
    expect(v.invoiceCount).toBe(5);
    expect(v.customers.map((c) => [c.name, c.total, c.invoices])).toEqual([["Alpha Co", 300.3, 2], [null, 1.01, 1]]);
    expect(v.customers[0]?.buckets).toEqual({ current: 0, "1_30": 0, "31_60": 200.2, "61_90": 0, "90_plus": 100.1 });
    expect(v.customers[0]?.detail).toEqual([{ issueDate: "2026-08-01", dueDate: "2026-08-06", daysOverdue: 95, balance: 100.1 }, { issueDate: "2026-10-01", dueDate: null, daysOverdue: 40, balance: 200.2 }]);
    expect([v.customerCount, v.customersShown, v.customerCap, v.invoiceCap, v.unreadableCustomers]).toEqual([3, 2, 50, 25, 0]);
    expect(v.check).toEqual({ kind: "ok", total: 360, reportDate: "2026-11-27", difference: 1.36 });
    expect([v.connectionStatus, v.lastSyncAt, v.businessDate]).toEqual(["active", "2026-11-27T14:55:00.000Z", "2026-11-27"]);
  });
  it("a check that is missing carries its reason; an unknown reason is unreadable; no check fields at all is no check line", () => {
    expect(toReceivables([arRow({ check_reason: "withheld", check_total: null, check_difference: null, check_report_date: null })])).toMatchObject({ check: { kind: "missing", reason: "withheld" } });
    expect(toReceivables([arRow({ check_reason: "something_new", check_total: null })])).toMatchObject({ check: { kind: "missing", reason: "unreadable" } });
    expect(toReceivables([arRow({ check_total: null, check_difference: null })])).toMatchObject({ check: null });
  });
  it("a customer with an unreadable figure is dropped and COUNTED as unreadable; the cap numbers stay SQL's (a dropped row is never the cap)", () => {
    const v = toReceivables([arRow({ customers: [cust({ total: "x" }), cust({ "31_60": null }), cust()] })]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.customers).toHaveLength(1);
    expect(v.unreadableCustomers).toBe(2);
    expect([v.customerCount, v.customersShown]).toEqual([3, 2]);
  });
  it("several current connections is a reason of its own", () => {
    expect(toReceivables([arRow({ check_reason: "several_connections", check_total: null, check_difference: null, check_report_date: null })])).toMatchObject({ check: { kind: "missing", reason: "several_connections" } });
  });
  it("days overdue is never negative and an unreadable invoice row is dropped", () => {
    const v = toReceivables([arRow({ customers: [cust({ detail: [{ issue_date: "2026-11-01", due_date: "2026-12-01", days_overdue: -3, balance: 5 }, { balance: "x", days_overdue: 1 }] })] })]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.customers[0]?.detail).toEqual([{ issueDate: "2026-11-01", dueDate: "2026-12-01", daysOverdue: 0, balance: 5 }]);
  });
  it("a state without figures has none; fails closed to no_access", () => {
    expect(toReceivables([{ state: "not_connected", as_of: null, last_sync_at: null, connection_status: null, business_date: "2026-11-27", buckets: [], total: null, invoice_count: 0, customers: [], customer_count: 0 }]))
      .toMatchObject({ state: "not_connected", total: null, buckets: [], customers: [], check: null });
    for (const bad of [null, [], [{ state: "weird" }], [{ state: "no_access" }]]) expect(toReceivables(bad)).toEqual({ state: "no_access" });
  });
});

const week = (over: Record<string, unknown> = {}) => ({ start: "2026-11-21", end: "2026-11-27", through: "2026-11-27", is_current: true, invoiced_count: 2, invoiced_amount: 1000.5, received_count: 1, received_amount: "100.00", ...over });

describe("toFinanceWeekly", () => {
  it("maps the weeks newest first as SQL gave them; counts and amounts as given", () => {
    const v = toFinanceWeekly([{ state: "ok", as_of: "2026-11-27T15:00:00Z", last_sync_at: null, connection_status: "degraded", business_date: "2026-11-27", weeks: [week(), week({ start: "2026-11-14", end: "2026-11-20", through: "2026-11-20", is_current: false, invoiced_count: 0, invoiced_amount: 0 })] }]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.weeks.map((w) => [w.start, w.end, w.isCurrent, w.invoicedCount, w.invoicedAmount, w.receivedCount, w.receivedAmount])).toEqual([
      ["2026-11-21", "2026-11-27", true, 2, 1000.5, 1, 100], ["2026-11-14", "2026-11-20", false, 0, 0, 1, 100],
    ]);
    expect(v.connectionStatus).toBe("degraded");
  });
  it("a week with an unreadable figure or date is dropped, never shown as zero", () => {
    const v = toFinanceWeekly([{ state: "ok", weeks: [week({ invoiced_amount: null }), week({ start: "soon" }), week({ received_amount: "x" })] }]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.weeks).toEqual([]);
  });
  it("other states have no weeks; fails closed", () => {
    expect(toFinanceWeekly([{ state: "no_data", weeks: [week()] }])).toMatchObject({ state: "no_data", weeks: [] });
    for (const bad of [undefined, [], [{ state: "x" }], [{ state: "no_access" }]]) expect(toFinanceWeekly(bad)).toEqual({ state: "no_access" });
  });
});

describe("toWeekDetail", () => {
  const ok = { state: "ok", week_valid: true, week_start: "2026-11-14", week_end: "2026-11-20", invoice_count: 55, payment_count: 1, row_cap: 50,
    invoices: [{ customer: "Eps Co", date: "2026-11-14", total: 300, open_balance: "0.00" }, { customer: null, date: "2026-11-15", total: 5, open_balance: 5 }], payments: [{ customer: "Delta Co", date: "2026-11-16", amount: 74.75 }] };
  it("maps invoices and payments; the counts are SQL's (a capped list is shorter than the count)", () => {
    expect(toWeekDetail([ok])).toEqual({
      state: "ok", start: "2026-11-14", end: "2026-11-20", invoiceCount: 55, paymentCount: 1, rowCap: 50,
      invoices: [{ customer: "Eps Co", date: "2026-11-14", total: 300, openBalance: 0 }, { customer: null, date: "2026-11-15", total: 5, openBalance: 5 }],
      payments: [{ customer: "Delta Co", date: "2026-11-16", amount: 74.75 }],
    });
  });
  it("an invalid week, another state or no row is none", () => {
    expect(toWeekDetail([{ ...ok, week_valid: false }])).toEqual({ state: "none" });
    expect(toWeekDetail([{ ...ok, state: "no_data" }])).toEqual({ state: "none" });
    expect(toWeekDetail([])).toEqual({ state: "none" });
  });
});

describe("parseWeek", () => {
  it("a real calendar date or nothing; whether it is a Saturday in range is the database's decision", () => {
    expect(parseWeek("2026-11-21")).toBe("2026-11-21");
    for (const bad of [undefined, null, "", "2026-13-01", "2026-02-30", "26-11-21", "2026-11-21T00:00", ["2026-11-21"], "2026-11-21 ", "'; drop table", 20261121]) expect(parseWeek(bad)).toBeNull();
  });
});

describe("tabs", () => {
  it("Overview, Cash, Receivables, Invoices & payments (Cash second, T-302)", () => {
    expect(FINANCE_TABS.map((t) => [t.key, t.segment])).toEqual([["overview", "finance"], ["cash", "finance/cash"], ["receivables", "finance/receivables"], ["weekly", "finance/weekly"]]);
  });
});

const rpc = (result: { data: unknown; error: unknown }) => {
  const fn = vi.fn(() => Promise.resolve(result));
  return { fn, client: { schema: vi.fn(() => ({ rpc: fn })) } as never };
};

describe("loaders", () => {
  it("call the three functions with the lane and, for the detail, the week; the number of weeks is not passed (SQL reads lane_config)", async () => {
    const a = rpc({ data: [arRow()], error: null });
    await loadReceivables(a.client, "PKG");
    expect(a.fn).toHaveBeenCalledWith("finance_receivables", { p_lane: "PKG" });
    const w = rpc({ data: [{ state: "ok", weeks: [] }], error: null });
    await loadFinanceWeekly(w.client, "PKG");
    expect(w.fn).toHaveBeenCalledWith("finance_weekly", { p_lane: "PKG" });
    const d = rpc({ data: [], error: null });
    await loadWeekDetail(d.client, "PKG", "2026-11-21");
    expect(d.fn).toHaveBeenCalledWith("finance_week_detail", { p_lane: "PKG", p_week: "2026-11-21" });
  });
  it("a database error throws", async () => {
    await expect(loadReceivables(rpc({ data: null, error: { message: "x" } }).client, "PKG")).rejects.toThrow();
  });
  it("the guarded readers run the lane check first and turn any failure into unavailable (never an empty figure)", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const order: string[] = [];
      const g = { requireLane: vi.fn(() => { order.push("lane"); return Promise.resolve({ client: {} as never, session: {} as never }); }) } as never;
      const load = vi.fn(() => { order.push("load"); return Promise.resolve({ state: "no_data" }) as never; });
      await receivablesFor(g, "PKG", load);
      expect(order).toEqual(["lane", "load"]);
      const refused = { requireLane: vi.fn(() => Promise.reject(new Error("no"))) } as never;
      expect(await receivablesFor(refused, "PKG", load)).toEqual({ state: "unavailable" });
      expect(await financeWeeklyFor(refused, "PKG", load)).toEqual({ state: "unavailable" });
      expect(await weekDetailFor(refused, "PKG", "2026-11-21", load)).toEqual({ state: "unavailable" });
      expect(await weekDetailFor(refused, "PKG", null, load)).toEqual({ state: "none" });
      const failing = { requireLane: vi.fn(() => Promise.resolve({ client: {} as never, session: {} as never })) } as never;
      expect(await financeWeeklyFor(failing, "PKG", () => Promise.reject(new TypeError("boom")))).toEqual({ state: "unavailable" });
    } finally {
      quiet.mockRestore();
    }
  });
});
