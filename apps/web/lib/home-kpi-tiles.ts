// The Home KPI tiles (T-234 part 1, T-235 part 4: only what is connected). Up to five: Cash (book balance), AR > 30 days, P&L MTD, MRR, Paid subscribers. Figures
// come only from SQL: the three QuickBooks tiles from `core.home_finance` (T-233, via financeCards: formatted, never
// computed here). MRR (Stripe) and Paid subscribers (GoHighLevel) have no read yet, so they are always the
// not-connected / waiting state, never a number. The list is fixed by the brief and kept as data so the page maps over it.
import { connectionNote, financeCards, type FinanceCardKey, type HomeFinanceView } from "./home-finance";
import { homeKpis, type HomeView } from "./home";

export type KpiTile = {
  key: string;
  label: string;
  bookBalance: boolean;
  /** Pre-formatted figure; only when SQL returned one. */
  value?: string;
  /** Short line under the label (P&L: "Net, November 2026"). */
  qualifier?: string;
  /** What the figure leaves out (rule 7 / D-18), e.g. "Excludes 2 unmapped accounts". Shown above the note. */
  flags: string[];
  /** Small line under the figure ("As of ...", or why there is none). Absent for a connect tile. */
  note?: string;
  /** Not connected: the tile shows "Not connected · Connect" linking to Settings -> Connections. */
  connect: boolean;
};

const FINANCE_LABEL: Record<FinanceCardKey, string> = { cash: "Cash", ar30: "AR > 30 days", pnl: "P&L MTD" };
const FINANCE_KEYS: FinanceCardKey[] = ["cash", "ar30", "pnl"];

export function kpiTiles(finance: HomeFinanceView, feeds: HomeView["feeds"]): KpiTile[] {
  const base = (key: FinanceCardKey) => ({ key, label: FINANCE_LABEL[key], bookBalance: key === "cash", flags: [] as string[] });
  let qb: KpiTile[];
  if (finance.state === "unavailable") qb = FINANCE_KEYS.map((k) => ({ ...base(k), connect: false, note: "Could not load. Reload in a minute." }));
  else if (finance.state === "no_access") qb = []; // a role without the finance view gets no finance tile at all
  else {
    const cards = financeCards(finance);
    const stale = connectionNote(finance) !== null; // reconnect_required / degraded: say so on every figure
    qb = FINANCE_KEYS.map((k) => {
      const c = cards.find((x) => x.key === k);
      if (!c) return { ...base(k), connect: false, note: "Not available yet" };
      if (c.value) return { ...base(k), connect: false, value: c.value, ...(c.qualifier ? { qualifier: c.qualifier } : {}), flags: c.flags, ...(stale ? { note: "May be out of date. Reconnect QuickBooks in Settings." } : c.asOf ? { note: c.asOf } : {}) };
      if (c.connectLink) return { ...base(k), connect: true };
      return { ...base(k), connect: false, ...(c.statusText ? { note: c.statusText } : {}) };
    });
  }
  const other = homeKpis(feeds).filter((k) => k.connected).map((k): KpiTile => (k.connect ? { key: k.key, label: k.label, bookBalance: false, flags: [], connect: true } : { key: k.key, label: k.label, bookBalance: false, flags: [], connect: false, note: k.statusText }));
  // T-235 part 4: a tile exists only for a connected source. A tile that would say "Not connected" is dropped; with
  // none left the strip shows one slim banner instead (kpi-strip.tsx). Stripe and GoHighLevel have no connector yet.
  return [...qb, ...other].filter((t) => !t.connect);
}
