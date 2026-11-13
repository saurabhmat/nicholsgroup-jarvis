// The Home KPI tiles (T-234 part 1, T-235 part 4, T-237 part B): Cash (book balance), AR over 30 days, Bills due in 14 days,
// Net income MTD (all four QuickBooks) and MRR (Stripe). Figures come only from SQL (`core.home_finance`, `core.home_finance_detail`),
// formatted here, never computed. MRR has no read yet, so it is always the waiting state, never a number. No comparison with a
// prior month is shown (there is no prior-month data). The row shows only connected sources (T-235). With QuickBooks not connected
// (T-240) there are no QuickBooks tiles and, for a role that can connect, one slim strip line (`quickbooksStrip`) instead of the old
// full-size "Connect QuickBooks" tile. A role without the finance view gets no finance tile and no strip at all.
import { connectionNote, financeCards, formatMoney, type FinanceCardKey, type HomeFinanceView } from "./home-finance";
import type { HomeFinanceDetail } from "./home-finance-detail";
import { homeKpis, type HomeView } from "./home";

export type KpiTone = "danger" | "success";
export type KpiTile = {
  key: string;
  label: string;
  bookBalance: boolean;
  /** Pre-formatted figure; only when SQL returned one. */
  value?: string;
  /** Short line under the label. */
  qualifier?: string;
  /** What the figure leaves out (rule 7 / D-18), e.g. "Excludes 2 unmapped accounts". Shown above the note. */
  flags: string[];
  /** Small line under the figure ("3 accounts · QuickBooks", or why there is none). */
  note?: string;
  /** Colour of the figure: AR over 30 days is danger when above zero, net income is success when positive. */
  tone?: KpiTone;
};

/** The slim QuickBooks line above the KPI row (T-240). `canConnect` = owner / admin_technical: only they get the action link. */
export type QuickbooksStrip = { kind: "not_connected" | "reconnect_required"; text: string; canConnect: boolean; actionLabel: string };

type Key = FinanceCardKey | "bills14";
const LABEL: Record<Key, string> = { cash: "Cash", ar30: "AR over 30 days", bills14: "Bills due in 14 days", pnl: "Net income \u00b7 MTD" };
const KEYS: Key[] = ["cash", "ar30", "bills14", "pnl"];
const SOURCE = "QuickBooks";
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export const QUICKBOOKS_NOT_CONNECTED_TEXT = "QuickBooks is not connected. Connect it to see cash, AR and bills.";
export const QUICKBOOKS_RECONNECT_TEXT = "QuickBooks needs to be reconnected. Its figures may be out of date.";

/**
 * The strip line: "not connected" (only for a role that can connect: others are not told about finance sources) or, when QuickBooks is
 * connected but its connection needs a reconnect, that instead (shown to every role that holds the finance view; the action only for
 * a role that can connect). Null for a role without the finance view, during an outage, and when all is well.
 */
export function quickbooksStrip(finance: HomeFinanceView, canConnect: boolean): QuickbooksStrip | null {
  if (finance.state === "no_access" || finance.state === "unavailable") return null;
  if (finance.connectionStatus === "reconnect_required") return { kind: "reconnect_required", text: QUICKBOOKS_RECONNECT_TEXT, canConnect, actionLabel: "Reconnect" };
  if (finance.state === "not_connected" && canConnect) return { kind: "not_connected", text: QUICKBOOKS_NOT_CONNECTED_TEXT, canConnect, actionLabel: "Connect" };
  return null;
}

export function kpiTiles(finance: HomeFinanceView, detail: HomeFinanceDetail, feeds: HomeView["feeds"]): KpiTile[] {
  const base = (key: Key): KpiTile => ({ key, label: LABEL[key], bookBalance: key === "cash", flags: [] });
  let qb: KpiTile[];
  if (finance.state === "unavailable") qb = KEYS.map((k) => ({ ...base(k), note: "Could not load. Reload in a minute." }));
  else if (finance.state === "no_access") qb = []; // a role without the finance view gets no finance tile at all
  else if (finance.state === "not_connected") qb = []; // the slim strip says so (quickbooksStrip)
  else {
    const cards = financeCards(finance);
    const stale = connectionNote(finance) !== null; // reconnect_required / degraded: say so on every figure
    const staleFlag = stale ? ["May be out of date. Reconnect QuickBooks in Settings."] : [];
    qb = KEYS.map((k): KpiTile => {
      if (k === "bills14") {
        if (detail.state === "ok" && detail.bills.total !== null) {
          return { ...base(k), value: formatMoney(detail.bills.total), flags: [...(detail.unmappedBills > 0 ? [`Excludes ${plural(detail.unmappedBills, "bill", "bills")} with no company`] : []), ...staleFlag], note: `${plural(detail.bills.count, "bill", "bills")} \u00b7 ${SOURCE}` };
        }
        return { ...base(k), note: detail.state === "unavailable" ? "Could not load. Reload in a minute." : "Not available yet" };
      }
      const c = cards.find((x) => x.key === k);
      if (!c) return { ...base(k), note: "Not available yet" };
      if (!c.value) return { ...base(k), ...(c.statusText ? { note: c.statusText } : {}) };
      const out: KpiTile = { ...base(k), value: c.value, flags: [...c.flags, ...staleFlag] };
      if (k === "cash") {
        const n = finance.cash.accounts.length;
        out.note = n > 0 ? `${plural(n, "account", "accounts")} \u00b7 ${SOURCE}` : SOURCE;
      } else if (k === "ar30") {
        out.note = `${plural(finance.ar.invoices, "invoice", "invoices")} \u00b7 ${SOURCE}`;
        if ((finance.ar.over30 ?? 0) > 0) out.tone = "danger";
      } else {
        out.note = SOURCE;
        if ((finance.pnl.net ?? 0) > 0) out.tone = "success";
      }
      return out;
    });
  }
  // MRR (Stripe) only when a Stripe feed is connected. A role without the finance view sees none of the revenue tiles either.
  // A feed that needs a reconnect gets no tile (homeKpis marks it `connect`); Settings -> Connections shows it.
  const other =
    finance.state === "no_access"
      ? []
      : homeKpis(feeds)
          .filter((k) => k.key === "mrr" && k.connected && !k.connect)
          .map((k): KpiTile => ({ key: k.key, label: k.label, bookBalance: false, flags: [], note: k.statusText }));
  return [...qb, ...other];
}
