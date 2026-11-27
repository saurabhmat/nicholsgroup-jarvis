// T-300, T-301: synthetic Finance report data shared by the view tests (rule 10). Test-only: never imported by the app.
import { toFinanceWeekly, toReceivables, toWeekDetail } from "@/lib/finance-reports";
import type { WeeklyData } from "./finance-weekly";

const buckets = [
  { bucket: "current", total: 51.06, count: 2 }, { bucket: "1_30", total: 0, count: 0 }, { bucket: "31_60", total: 210.2, count: 2 }, { bucket: "61_90", total: 0, count: 0 }, { bucket: "90_plus", total: 100.1, count: 1 },
];
const alpha = {
  name: "Alpha Co", current: 0, "1_30": 0, "31_60": 200.2, "61_90": 0, "90_plus": 100.1, total: 300.3, invoices: 2, detail_shown: 2,
  detail: [{ issue_date: "2026-08-01", due_date: "2026-08-06", days_overdue: 95, balance: 100.1 }, { issue_date: "2026-10-01", due_date: null, days_overdue: 40, balance: 200.2 }],
};
const beta = { name: "Beta Co", current: 50.05, "1_30": 0, "31_60": 10, "61_90": 0, "90_plus": 0, total: 60.05, invoices: 2, detail_shown: 2, detail: [{ issue_date: "2026-10-10", due_date: "2026-12-01", days_overdue: 0, balance: 50.05 }, { issue_date: "2026-10-14", due_date: null, days_overdue: 44, balance: 10 }] };
const nobody = { name: null, current: 1.01, "1_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0, total: 1.01, invoices: 1, detail_shown: 1, detail: [{ issue_date: "2026-11-24", due_date: "2026-11-27", days_overdue: 0, balance: 1.01 }] };

const arOk = {
  state: "ok", as_of: "2026-11-27T15:00:00Z", last_sync_at: "2026-11-27T14:55:00Z", connection_status: "active", business_date: "2026-11-27", buckets, total: 361.36, invoice_count: 5,
  customers: [alpha, beta, nobody], customer_count: 3, customers_shown: 3, customer_cap: 50, invoice_cap: 25,
  check_reason: null, check_total: 360, check_report_date: "2026-11-27", check_difference: 1.36,
};

export const receivables = (over: Record<string, unknown> = {}) => toReceivables([{ ...arOk, ...over }]);

const w = (start: string, end: string, through: string, cur: boolean, ic: number, ia: number, rc: number, ra: number) =>
  ({ start, end, through, is_current: cur, invoiced_count: ic, invoiced_amount: ia, received_count: rc, received_amount: ra });
const weeksRow = {
  state: "ok", as_of: "2026-11-27T15:00:00Z", last_sync_at: "2026-11-27T14:55:00Z", connection_status: "active", business_date: "2026-11-27",
  weeks: [
    w("2026-11-21", "2026-11-27", "2026-11-27", true, 2, 1000.5, 1, 100),
    w("2026-11-14", "2026-11-20", "2026-11-20", false, 2, 500, 3, 100.01),
    w("2026-11-07", "2026-11-13", "2026-11-13", false, 1, 40, 0, 0),
    w("2026-10-31", "2026-11-06", "2026-11-06", false, 0, 0, 0, 0),
    w("2026-10-24", "2026-10-30", "2026-10-30", false, 1, 5.55, 0, 0),
  ],
};
const detailRow = {
  state: "ok", week_valid: true, week_start: "2026-11-14", week_end: "2026-11-20", invoice_count: 2, payment_count: 3, row_cap: 50,
  invoices: [{ customer: "Eps Co", date: "2026-11-14", total: 300, open_balance: 0 }, { customer: "Gamma Co", date: "2026-11-20", total: 200, open_balance: 20 }],
  payments: [{ customer: "Delta Co", date: "2026-11-14", amount: 74.75 }, { customer: "Eps Co", date: "2026-11-20", amount: 0.01 }, { customer: null, date: "2026-11-20", amount: 25.25 }],
};

export function weekly(over: { weekly?: Record<string, unknown>; detail?: Record<string, unknown> | null; week?: string | null } = {}): WeeklyData {
  const week = over.week === undefined ? null : over.week;
  return {
    weekly: toFinanceWeekly([{ ...weeksRow, ...over.weekly }]),
    detail: over.detail === null || week === null ? { state: "none" } : toWeekDetail([{ ...detailRow, ...over.detail }]),
    week,
  };
}
