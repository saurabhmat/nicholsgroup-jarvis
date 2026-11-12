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
  /** Small line under the figure ("As of ...", or why there is none). */
  note?: string;
};

const FINANCE_LABEL: Record<FinanceCardKey, string> = { cash: "Cash", ar30: "AR > 30 days", pnl: "P&L MTD" };
const FINANCE_KEYS: FinanceCardKey[] = ["cash", "ar30", "pnl"];

export function kpiTiles(finance: HomeFinanceView, feeds: HomeView["feeds"]): KpiTile[] {
  const base = (key: FinanceCardKey) => ({ key, label: FINANCE_LABEL[key], bookBalance: key === "cash", flags: [] as string[] });
  let qb: (KpiTile | null)[];
  if (finance.state === "unavailable") qb = FINANCE_KEYS.map((k) => ({ ...base(k), note: "Could not load. Reload in a minute." }));
  else if (finance.state === "no_access") qb = []; // a role without the finance view gets no finance tile at all
  else {
    const cards = financeCards(finance);
    const stale = connectionNote(finance) !== null; // reconnect_required / degraded: say so on every figure
    qb = FINANCE_KEYS.map((k) => {
      const c = cards.find((x) => x.key === k);
      if (!c) return { ...base(k), note: "Not available yet" };
      if (c.value) return { ...base(k), value: c.value, ...(c.qualifier ? { qualifier: c.qualifier } : {}), flags: c.flags, ...(stale ? { note: "May be out of date. Reconnect QuickBooks in Settings." } : c.asOf ? { note: c.asOf } : {}) };
      if (c.connectLink) return null; // not connected: no tile (part 4); the banner covers it
      return { ...base(k), ...(c.statusText ? { note: c.statusText } : {}) };
    });
  }
  // MRR and Paid subscribers come from Stripe / GoHighLevel feeds. A role without the finance view (no_access) sees none of
  // the revenue tiles either (future-proof: once those reads exist they are finance figures). A feed that is connected but
  // needs a reconnect gets no tile (homeKpis marks it `connect`); Settings -> Connections shows it. Low priority: say so there.
  const other =
    finance.state === "no_access"
      ? []
      : homeKpis(feeds)
          .filter((k) => k.connected && !k.connect)
          .map((k): KpiTile => ({ key: k.key, label: k.label, bookBalance: false, flags: [], note: k.statusText }));
  // T-235 part 4: a tile exists only for a connected source; with none left the strip shows one slim banner (kpi-strip.tsx).
  return [...qb, ...other].filter((t): t is KpiTile => t !== null);
}
