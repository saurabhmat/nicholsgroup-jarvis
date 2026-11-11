// Home finance cards (T-233): Cash (labelled "Book balance"), AR over 30 days and P&L month to date, from QuickBooks via
// `core.home_finance`. A role that may not see finance gets nothing here. Empty states say what to do; no sample numbers.
import Link from "next/link";
import { KpiCard, laneHref } from "@nichols/ui";
import { guards } from "@/lib/guards";
import { connectionNote, financeCards, homeFinanceFor, type FinanceCard, type HomeFinanceView } from "@/lib/home-finance";
import { timed } from "@/lib/timed";
import { CardSkeleton } from "./page-skeleton";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

/** Placeholder while the finance read runs (the page wraps `HomeFinance` in its own Suspense boundary, so a slow read never holds Home back). */
export function HomeFinanceFallback() {
  return (
    <div className={GRID} aria-hidden>
      <CardSkeleton />
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

export async function HomeFinance({ laneId }: { laneId: string }) {
  const view = await timed("load.home_finance", async () => homeFinanceFor(await guards(), laneId));
  return <FinanceCards laneId={laneId} view={view} />;
}

export function FinanceCards({ laneId, view }: { laneId: string; view: HomeFinanceView }) {
  const settings = `${laneHref(laneId, "settings")}#connections`;
  if (view.state === "unavailable") {
    return (
      <section aria-label="QuickBooks figures" data-testid="home-finance" className={GRID}>
        {(["Cash", "AR > 30 days", "P&L month to date"] as const).map((label) => (
          <KpiCard key={label} label={label} bookBalance={label === "Cash"} status="no_data" statusText="Could not load QuickBooks figures. Reload in a minute." />
        ))}
      </section>
    );
  }
  const cards = financeCards(view);
  if (cards.length === 0) return null;
  const note = connectionNote(view);
  return (
    <section aria-label="QuickBooks figures" data-testid="home-finance" className="flex flex-col gap-2">
      {note ? (
        <p data-testid="home-finance-note" className="text-small text-muted-foreground">
          {note}{" "}
          <Link href={settings} className="font-medium text-primary underline-offset-2 hover:underline">
            Open Settings
          </Link>
        </p>
      ) : null}
      <div className={GRID}>
        {cards.map((c) => (
          <Card key={c.key} card={c} settingsHref={settings} />
        ))}
      </div>
    </section>
  );
}

function Card({ card, settingsHref }: { card: FinanceCard; settingsHref: string }) {
  const hasFooter = card.asOf !== null || card.details.length > 0 || card.accounts.length > 0 || card.connectLink;
  return (
    <KpiCard
      label={card.label}
      qualifier={card.qualifier}
      bookBalance={card.bookBalance}
      status={card.value ? "ok" : "no_data"}
      value={card.value}
      statusText={card.statusText}
      footer={
        hasFooter ? (
          <div className="flex w-full min-w-0 flex-col gap-1 text-small text-muted-foreground">
            {card.accounts.length > 0 ? (
              <ul data-testid="cash-accounts" className="flex flex-col gap-0.5">
                {card.accounts.map((a) => (
                  <li key={a.name} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {a.name}
                      {a.shared ? " (shared)" : ""}
                    </span>
                    <span className="shrink-0 tabular-nums text-foreground">{a.value}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {card.details.map((d) => (
              <p key={d}>{d}</p>
            ))}
            {card.asOf ? <p className="tabular-nums">{`QuickBooks · ${card.asOf}`}</p> : null}
            {card.connectLink ? (
              <Link href={settingsHref} className="font-medium text-primary underline-offset-2 hover:underline">
                Open Settings
              </Link>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}
