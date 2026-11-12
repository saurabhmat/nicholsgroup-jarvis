// Home finance detail (T-237 part B/C): bills due in 14 days, receivables aging and the oldest unpaid invoices from
// `core.home_finance_detail` (SECURITY INVOKER, RLS: AAL2 + the lane's finance view). Every figure is computed in SQL (rule 7);
// this file only maps the row defensively (like toHomeFinance), and derives bar WIDTHS for display. It never adds money.
import type { Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { count, instant, num, text, type FinanceState } from "./home-finance";

export const AGING_BUCKETS = ["current", "1_30", "31_60", "61_90", "90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABEL: Record<AgingBucket, string> = { current: "Current", "1_30": "1–30", "31_60": "31–60", "61_90": "61–90", "90_plus": "90+" };

export type AgingRow = { bucket: AgingBucket; total: number; count: number };
export type OldestInvoice = { customer: string | null; balance: number; daysOverdue: number };

export type HomeFinanceDetail =
  | { state: "unavailable" }
  | { state: "no_access" }
  | {
      state: Exclude<FinanceState, "no_access">;
      asOf: string | null;
      bills: { total: number | null; count: number };
      /** The five buckets in order (only when state is ok and every bucket was readable), else []. */
      aging: AgingRow[];
      oldest: OldestInvoice[];
      unmappedInvoices: number;
      unmappedBills: number;
    };

const STATES: readonly string[] = ["not_connected", "no_data", "mapping_missing", "ok", "no_access"];

function toAging(v: unknown): AgingRow[] {
  if (!Array.isArray(v)) return [];
  const by = new Map<string, AgingRow>();
  for (const x of v) {
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    const bucket = (AGING_BUCKETS as readonly string[]).find((b) => b === r.bucket);
    const total = num(r.total);
    if (bucket && total !== null) by.set(bucket, { bucket: bucket as AgingBucket, total, count: count(r.count) });
  }
  // All five or none: a partial chart would mislead.
  return AGING_BUCKETS.every((b) => by.has(b)) ? AGING_BUCKETS.map((b) => by.get(b) as AgingRow) : [];
}

function toOldest(v: unknown): OldestInvoice[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 3).flatMap((x: unknown) => {
    if (typeof x !== "object" || x === null) return [];
    const r = x as Record<string, unknown>;
    const balance = num(r.balance);
    const days = num(r.days_overdue);
    if (balance === null || days === null || days < 1) return [];
    return [{ customer: text(r.customer), balance, daysOverdue: Math.floor(days) }];
  });
}

/** The one row of core.home_finance_detail. Unknown states fail closed to no_access. */
export function toHomeFinanceDetail(data: unknown): HomeFinanceDetail {
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || typeof row.state !== "string" || !STATES.includes(row.state) || row.state === "no_access") return { state: "no_access" };
  return {
    state: row.state as Exclude<FinanceState, "no_access">,
    asOf: instant(row.as_of),
    bills: { total: num(row.bills_due_14_total), count: count(row.bills_due_14_count) },
    aging: toAging(row.aging),
    oldest: toOldest(row.oldest),
    unmappedInvoices: count(row.unmapped_invoices),
    unmappedBills: count(row.unmapped_bills),
  };
}

/** Display only: width percentages (0 to 100) of values against the largest of them; a zero or negative value gets 0. */
export function barWidths(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 && v > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0));
}

type Db = Pick<LaneClient, "schema">;

export async function loadHomeFinanceDetail(client: Db, laneId: string): Promise<HomeFinanceDetail> {
  const { data, error } = await client.schema("core").rpc("home_finance_detail", { p_lane: laneId });
  if (error) throw new Error("finance detail unavailable");
  return toHomeFinanceDetail(data);
}

/** An outage gives `unavailable`, never an empty or invented figure. */
export async function homeFinanceDetailFor(g: Pick<Guards, "requireLane">, laneId: string, load = loadHomeFinanceDetail): Promise<HomeFinanceDetail> {
  try {
    const { client } = await g.requireLane(laneId as Parameters<Guards["requireLane"]>[0]);
    return await load(client, laneId);
  } catch (e) {
    console.error("[home] finance detail unavailable", { laneId, reason: e instanceof Error ? e.name : typeof e });
    return { state: "unavailable" };
  }
}
