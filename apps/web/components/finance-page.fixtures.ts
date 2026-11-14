// T-245: synthetic Finance page data shared by the view tests (rule 10). Test-only: imported by *.test.tsx files, never by the app.
import { toHomeFinance } from "@/lib/home-finance";
import { toHomeFinanceDetail } from "@/lib/home-finance-detail";
import { toFinanceOverview, toFinancePnl, type FinancePeriod } from "@/lib/finance-page";
import type { FinanceData } from "./finance-page";

const accounts = [
  { name: "Operating", book_balance: 1500.5, shared: false },
  { name: "Reserve", book_balance: 500.5, shared: true },
];
const okRow = {
  state: "ok", as_of: "2026-11-14T12:00:00Z", last_sync_at: "2026-11-14T11:55:00Z", connection_status: "active",
  cash_reason: null, cash_total: 2001, cash_as_of: "2026-11-14T11:55:00Z", cash_accounts: accounts, cash_unmapped: 1,
  ar_reason: null, ar_over_30: 160.25, ar_invoices: 3, ar_unmapped: 0,
  pnl_reason: null, pnl_income: 1000, pnl_expenses: 400, pnl_net: 600, pnl_start: "2026-11-01", pnl_end: "2026-11-14", pnl_method: "accrual", pnl_partial: false, pnl_as_of: null,
};
const aging = [
  { bucket: "current", total: 400, count: 2 }, { bucket: "1_30", total: 200, count: 1 }, { bucket: "31_60", total: 100, count: 1 }, { bucket: "61_90", total: 50, count: 1 }, { bucket: "90_plus", total: 0, count: 0 },
];
const detailRow = { state: "ok", as_of: "2026-11-14T12:00:00Z", bills_due_14_total: 410.5, bills_due_14_count: 2, aging, oldest: [], unmapped_invoices: 2, unmapped_bills: 0 };
const pnlRow = {
  state: "ok", as_of: "2026-11-14T12:00:00Z", last_sync_at: "2026-11-14T11:55:00Z", connection_status: "active", period: "mtd", window_start: "2026-11-01", window_end: "2026-11-14",
  pnl_reason: null, pnl_income: 1000, pnl_expenses: 400, pnl_net: 600, pnl_start: "2026-11-01", pnl_end: "2026-11-14", pnl_method: "accrual", pnl_partial: true, pnl_as_of: "2026-11-14T11:00:00Z",
};
const overviewRow = {
  state: "ok", as_of: "2026-11-14T12:00:00Z", last_sync_at: "2026-11-14T11:55:00Z", last_normalized_at: "2026-11-14T11:58:00Z", connection_status: "active", ar_total: 750, ar_invoices: 5, unmapped_bills_open: 1,
  reports: [{ report: "pnl", start_date: "2026-11-01", end_date: "2026-11-14", report_date: null, method: "accrual", class_filtered: false, as_of: "2026-11-14T11:00:00Z" }],
};

export function data(over: { finance?: Record<string, unknown>; detail?: Record<string, unknown>; pnl?: Record<string, unknown>; overview?: Record<string, unknown> } = {}, period: FinancePeriod = "mtd"): FinanceData {
  return {
    finance: toHomeFinance([{ ...okRow, ...over.finance }]),
    detail: toHomeFinanceDetail([{ ...detailRow, ...over.detail }]),
    pnl: toFinancePnl([{ ...pnlRow, ...over.pnl }], period),
    overview: toFinanceOverview([{ ...overviewRow, ...over.overview }]),
  };
}
