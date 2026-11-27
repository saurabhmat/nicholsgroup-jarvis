// T-302: mapping of core.finance_cash, its loader and the guarded reader. Synthetic figures only (rule 10). The mapper copies SQL's figures;
// nothing is added, subtracted or estimated here.
import { describe, expect, it, vi } from "vitest";
import { CASH_NOTE, financeCashFor, loadFinanceCash, toFinanceCash } from "./finance-reports";

const col = (kind: string, date: string, as_of: string | null, read: number, accounts = 2) => ({ kind, date, as_of, read, accounts });
const cell = (book_balance: number | string | null, change: number | string | null = null) => ({ book_balance, change });
const columns = [
  col("today", "2026-11-27", "2026-11-27T14:55:00Z", 2),
  col("week_end", "2026-11-20", "2026-11-27T07:00:00Z", 2),
  col("week_end", "2026-11-13", "2026-11-27T07:00:00Z", 1),
  col("week_end", "2026-11-06", null, 0),
];
const row = (over: Record<string, unknown> = {}) => ({
  state: "ok", as_of: "2026-11-27T15:00:00Z", last_sync_at: "2026-11-27T14:55:00Z", connection_status: "active", business_date: "2026-11-27", reason: null, weeks: 3, columns,
  accounts: [
    { name: "Operating Checking", shared: false, cells: [cell(1000.5, 99.5), cell("901.00", 101), cell(800, null), cell(null)] },
    { name: "Savings", shared: true, cells: [cell(2000.25, 100), cell(1900.25, null), cell(null), cell(null)] },
  ],
  totals: [{ ...cell(3000.75, 199.5), missing: 0 }, { ...cell(2801.25), missing: 0 }, { ...cell(null), missing: 1 }, { ...cell(null), missing: 2 }], ...over,
});

describe("toFinanceCash", () => {
  it("maps columns, accounts with positional cells, the shared flag and the totals as SQL sent them", () => {
    const v = toFinanceCash([row()]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.reason).toBeNull();
    expect(v.weeks).toBe(3);
    expect(v.columns.map((c) => [c.kind, c.date, c.read, c.accounts, c.asOf])).toEqual([
      ["today", "2026-11-27", 2, 2, "2026-11-27T14:55:00.000Z"], ["week_end", "2026-11-20", 2, 2, "2026-11-27T07:00:00.000Z"], ["week_end", "2026-11-13", 1, 2, "2026-11-27T07:00:00.000Z"], ["week_end", "2026-11-06", 0, 2, null],
    ]);
    expect(v.accounts.map((a) => [a.name, a.shared])).toEqual([["Operating Checking", false], ["Savings", true]]);
    expect(v.accounts[0]?.cells).toEqual([{ bookBalance: 1000.5, change: 99.5 }, { bookBalance: 901, change: 101 }, { bookBalance: 800, change: null }, { bookBalance: null, change: null }]);
    expect(v.totals).toEqual([{ bookBalance: 3000.75, change: 199.5, missing: 0 }, { bookBalance: 2801.25, change: null, missing: 0 }, { bookBalance: null, change: null, missing: 1 }, { bookBalance: null, change: null, missing: 2 }]);
    expect(v.unreadableAccounts).toBe(0);
  });
  it("a missing balance stays null: it is never turned into 0", () => {
    const v = toFinanceCash([row({ accounts: [{ name: "A", shared: false, cells: [cell(null), cell(undefined as never), cell(""), cell("x")] }] })]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.accounts[0]?.cells.map((c) => c.bookBalance)).toEqual([null, null, null, null]);
  });
  it("an account row whose cells do not match the columns is counted, not shown, and then no total is shown (it could be partial)", () => {
    const v = toFinanceCash([row({ accounts: [{ name: "A", shared: false, cells: [cell(1)] }, { name: "B", shared: false, cells: [cell(1), cell(2), cell(3), cell(4)] }, "x", { shared: true, cells: [] }] })]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.accounts.map((a) => a.name)).toEqual(["B"]);
    expect(v.unreadableAccounts).toBe(3);
    expect(v.totals).toEqual([]);
  });
  it("an unreadable column makes the whole table unreadable (cells are positional)", () => {
    const v = toFinanceCash([row({ columns: [...columns.slice(0, 3), { kind: "week_end", date: "soon" }] })]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.columns).toEqual([]);
    expect(v.accounts).toEqual([]);
    expect(v.totals).toEqual([]);
  });
  it("totals that do not match the columns are dropped", () => {
    const v = toFinanceCash([row({ totals: [{ ...cell(1), missing: 0 }] })]);
    if (v.state !== "ok") throw new Error("state");
    expect(v.totals).toEqual([]);
  });
  it("the reasons and the states carry no figures", () => {
    for (const reason of ["bank_mapping_missing", "no_own_bank_accounts"] as const) {
      const v = toFinanceCash([row({ reason, columns: [], accounts: [], totals: [] })]);
      if (v.state !== "ok") throw new Error("state");
      expect(v.reason).toBe(reason);
      expect(v.accounts).toEqual([]);
    }
    expect(toFinanceCash([row({ reason: "made up" })])).toMatchObject({ reason: null });
    for (const state of ["not_connected", "no_data", "mapping_missing"] as const) {
      const v = toFinanceCash([row({ state })]);
      expect(v).toMatchObject({ state, columns: [], accounts: [], totals: [] });
    }
  });
  it("no_access, an empty answer or an unknown state is no_access (no figure)", () => {
    expect(toFinanceCash([row({ state: "no_access" })])).toEqual({ state: "no_access" });
    expect(toFinanceCash([])).toEqual({ state: "no_access" });
    expect(toFinanceCash(null)).toEqual({ state: "no_access" });
    expect(toFinanceCash([row({ state: "maybe" })])).toEqual({ state: "no_access" });
  });
  it("the wording says book balance and that money in and out is not shown", () => {
    expect(CASH_NOTE).toContain("book balance");
    expect(CASH_NOTE).not.toMatch(/bank balance/i);
    expect(CASH_NOTE).toContain("money in and out is not shown");
    expect(CASH_NOTE).toContain("Payroll accounts are not listed");
  });
});

const rpc = (result: { data: unknown; error: unknown }) => {
  const fn = vi.fn(() => Promise.resolve(result));
  return { fn, client: { schema: vi.fn(() => ({ rpc: fn })) } as never };
};

describe("loader", () => {
  it("calls finance_cash with the lane only (the weeks come from lane_config, read by the database)", async () => {
    const r = rpc({ data: [row()], error: null });
    expect(await loadFinanceCash(r.client, "PKG")).toMatchObject({ state: "ok" });
    expect(r.fn).toHaveBeenCalledWith("finance_cash", { p_lane: "PKG" });
  });
  it("a database error throws; the guarded reader turns any failure into unavailable (never an empty figure)", async () => {
    await expect(loadFinanceCash(rpc({ data: null, error: { message: "x" } }).client, "PKG")).rejects.toThrow();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const refused = { requireLane: vi.fn(() => Promise.reject(new Error("no"))) } as never;
      expect(await financeCashFor(refused, "PKG")).toEqual({ state: "unavailable" });
      const failing = { requireLane: vi.fn(() => Promise.resolve({ client: {} as never, session: {} as never })) } as never;
      expect(await financeCashFor(failing, "PKG", () => Promise.reject(new TypeError("boom")))).toEqual({ state: "unavailable" });
      const ok = { requireLane: vi.fn(() => Promise.resolve({ client: {} as never, session: {} as never })) } as never;
      expect(await financeCashFor(ok, "PKG", () => Promise.resolve({ state: "no_data" } as never))).toEqual({ state: "no_data" });
    } finally {
      quiet.mockRestore();
    }
  });
});
