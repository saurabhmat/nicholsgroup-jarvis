// GovCon news card (T-234 part 4; the slot is from part 1). Shows the STORED digest only: rendering never fetches, and neither does
// the 5-minute page refresh (rule 9: the stories come from untrusted web search results, validated before they were stored).
// Items: headline (a link to the https source, new tab, noopener), a one-line "why it matters", source name and date. Model-derived
// text is rendered as React text only. States: a slim "GovCon news is off" line (a Settings link for admins), "No news yet today",
// "News could not be fetched: <fixed reason>"; the owner also gets Refresh (once an hour; "Monthly news budget reached" when capped).
import Link from "next/link";
import { httpsUrl } from "@nichols/briefing/domain";
import { laneHref, PageSection, SlimCard } from "@nichols/ui";
import { NewsRefresh } from "./news-refresh";
import { newsFailureText, registrableHost, type NewsCard, type NewsItem } from "@/lib/news-types";

export type { NewsItem } from "@/lib/news-types";

const BUSINESS_TZ = "America/New_York";
const safeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return BUSINESS_TZ;
  }
};

/** "7:00 AM" today, otherwise "Nov 11, 7:00 AM", in the viewer's zone. */
export function newsTime(iso: string, tz: string, now: Date): string {
  const zone = safeZone(tz);
  const d = new Date(iso);
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(x);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(d);
  return day(d) === day(now) ? clock : `${new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" }).format(d)}, ${clock}`;
}

const storyDate = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: safeZone(tz), month: "short", day: "numeric" }).format(new Date(iso)) : null);

/** Source name, where the link REALLY goes (its registrable host; "via host" when outside the lane's preferred domains) and the date. */
export function newsMeta(n: NewsItem, tz: string): string {
  const host = registrableHost(n.url);
  const where = host ? (n.preferred ? host : `via ${host}`) : null;
  return [n.source, where, storyDate(n.publishedAt, tz) ?? "date unknown"].filter(Boolean).join(" · ");
}

export function GovConNews({ laneId = "", card = null, tz = BUSINESS_TZ, now = new Date() }: { laneId?: string; card?: NewsCard | null; tz?: string; now?: Date }) {
  const configured = card?.configured === true;
  // Render the NORMALISED url (credentials and odd forms stripped by httpsUrl), never the raw string; unusable ones are dropped.
  const items = card?.configured ? card.items.flatMap((i) => { const url = httpsUrl(i.url); return url ? [{ ...i, url }] : []; }) : [];
  const reason = card?.failure ? newsFailureText(card.failure) : null;
  const refreshReason =
    !card || !card.canRefresh ? null : card.inFlight ? "A fetch is running." : card.budgetReached ? "Monthly news budget reached" : card.nextRefreshAt ? `Next refresh available at ${newsTime(card.nextRefreshAt, tz, now)}` : null;
  if (!configured) {
    // Off: one slim line (T-235 part 5), so it never takes 2/3 of a row. Only admins get the Settings link.
    return (
      <SlimCard title="GovCon news" data-testid="news-empty">
        <span>GovCon news is off</span>
        {card?.isAdmin && laneId ? (
          <>
            <span aria-hidden>{"\u00b7"}</span>
            <Link data-testid="news-admin-hint" href={`${laneHref(laneId, "settings")}#news`} className="font-medium text-primary underline underline-offset-2">
              Set up in Settings
            </Link>
          </>
        ) : null}
      </SlimCard>
    );
  }
  return (
    <PageSection title="GovCon news" note="Last 48 hours" className="h-full">
      {items.length > 0 ? (
        <>
          <ul data-testid="news-list" className="flex flex-col divide-y divide-border">
            {items.map((n) => (
              <li key={n.url} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-foreground underline-offset-2 hover:underline md:min-h-0">
                  {n.headline}
                </a>
                <span className="text-small text-foreground">{n.why}</span>
                <span data-testid="news-meta" className="text-small text-muted-foreground">
                  {newsMeta(n, tz)}
                </span>
              </li>
            ))}
          </ul>
          <p data-testid="news-updated" className="text-small text-muted-foreground">
            {card?.updatedAt ? `Updated ${newsTime(card.updatedAt, tz, now)}` : null}
            {reason ? <span data-testid="news-last-failure">{`${card?.updatedAt ? " · " : ""}Last refresh failed: ${reason}`}</span> : null}
          </p>
        </>
      ) : reason ? (
        <p data-testid="news-failed" role="status" className="text-body text-muted-foreground">
          {`News could not be fetched: ${reason}`}
        </p>
      ) : (
        <p data-testid="news-none" className="text-body text-muted-foreground">
          No news yet today
        </p>
      )}
      {card?.canRefresh && laneId ? (
        <div data-testid="news-footer" className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <NewsRefresh laneId={laneId} disabledReason={refreshReason} />
        </div>
      ) : null}
    </PageSection>
  );
}
