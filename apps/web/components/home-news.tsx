// GovCon news card (T-234 part 4; the slot is from part 1). Shows the STORED digest only: rendering never fetches, and neither does
// the 5-minute page refresh (rule 9: the stories come from untrusted web search results, validated before they were stored).
// Items: headline (a link to the https source, new tab, noopener), a one-line "why it matters", source name and date. Model-derived
// text is rendered as React text only. States: "News not configured" (off; a Settings hint for admins), "No news yet today",
// "News could not be fetched: <fixed reason>"; the owner also gets Refresh (once an hour; "Monthly news budget reached" when capped).
import Link from "next/link";
import { laneHref, PageSection } from "@nichols/ui";
import { NewsRefresh } from "./news-refresh";
import { newsFailureText, type NewsCard } from "@/lib/news-types";

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
const httpsOnly = (u: string) => /^https:\/\//i.test(u);

export function GovConNews({ laneId = "", card = null, tz = BUSINESS_TZ, now = new Date() }: { laneId?: string; card?: NewsCard | null; tz?: string; now?: Date }) {
  const configured = card?.configured === true;
  const items = configured ? card.items.filter((i) => httpsOnly(i.url)) : [];
  const reason = card?.failure ? newsFailureText(card.failure) : null;
  const refreshReason =
    !card || !card.canRefresh ? null : card.inFlight ? "A fetch is running." : card.budgetReached ? "Monthly news budget reached" : card.nextRefreshAt ? `Next refresh available at ${newsTime(card.nextRefreshAt, tz, now)}` : null;
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
                <span className="text-small text-muted-foreground">{[n.source, storyDate(n.publishedAt, tz)].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
          <p data-testid="news-updated" className="text-small text-muted-foreground">
            {card?.updatedAt ? `Updated ${newsTime(card.updatedAt, tz, now)}` : null}
            {reason ? <span data-testid="news-last-failure">{`${card?.updatedAt ? " · " : ""}Last refresh failed: ${reason}`}</span> : null}
          </p>
        </>
      ) : !configured ? (
        <div data-testid="news-empty" className="flex flex-col gap-1">
          <p className="text-body text-muted-foreground">News not configured</p>
          {card?.isAdmin && laneId ? (
            <p data-testid="news-admin-hint" className="text-small text-muted-foreground">
              An admin can see what is needed in{" "}
              <Link href={`${laneHref(laneId, "settings")}#news`} className="text-primary underline-offset-2 hover:underline">
                Settings
              </Link>
              .
            </p>
          ) : null}
        </div>
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
