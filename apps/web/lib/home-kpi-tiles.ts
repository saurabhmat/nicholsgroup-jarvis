// The Home KPI tiles (T-234 part 1, T-235 part 4, T-237 part B): Cash (book balance), AR over 30 days, Bills due in 14 days,
// Net income MTD (all four QuickBooks) and MRR (Stripe). Figures come only from SQL (`core.home_finance`, `core.home_finance_detail`),
// formatted here, never computed. MRR has no read yet, so it is always the waiting state, never a number. No comparison with a
// prior month is shown (there is no prior-month data). With QuickBooks not connected: ONE "Connect QuickBooks" tile for a role
// that can connect, instead of the four. A role without the finance view gets no finance tile at all.
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
  /** The "Connect QuickBooks" tile: a link to Settings -> Connections instead of a figure. */
  connect?: boolean;
};

type Key = FinanceCardKey | "bills14";
const LABEL: Record<Key, string> = { cash: "Cash", ar30: "AR over 30 days", bills14: "Bills due in 14 days", pnl: "Net income \u00b7 MTD" };
const KEYS: Key[] = ["cash", "ar30", "bills14", "pnl"];
const SOURCE = "QuickBooks";
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export const CONNECT_QUICKBOOKS_TILE: KpiTile = { key: "connect_quickbooks", label: "Connect QuickBooks", bookBalance: false, flags: [], connect: true };

export function kpiTiles(finance: HomeFinanceView, detail: HomeFinanceDetail, feeds: HomeView["feeds"], canConnect = false): KpiTile[] {
  const base = (key: Key): KpiTile => ({ key, label: LABEL[key], bookBalance: key === "cash", flags: [] });
  let qb: KpiTile[];
  if (finance.state === "unavailable") qb = KEYS.map((k) => ({ ...base(k), note: "Could not load. Reload in a minute." }));
  else if (finance.state === "no_access") qb = []; // a role without the finance view gets no finance tile at all
  else if (finance.state === "not_connected") qb = canConnect ? [CONNECT_QUICKBOOKS_TILE] : [];
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
