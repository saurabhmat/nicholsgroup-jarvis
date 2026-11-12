// Settings -> GovCon news (T-234 part 4): read-only status for the owner and admin_technical. Fixed texts only.
import { Card } from "@nichols/ui";
import { newsTime } from "./home-news";
import type { NewsSettingsView } from "@/lib/news-settings";

const usd = (n: number) => "$" + n.toFixed(2);

export function NewsSection({ view, tz, now }: { view: NewsSettingsView; tz: string; now: Date }) {
  const on = view.webAllowed && view.enabled;
  const fetches = String(view.monthFetches) + (view.monthFetches === 1 ? " fetch" : " fetches");
  const last = view.lastFetchAt ? newsTime(view.lastFetchAt, tz, now) + " · " + (view.lastStatus === "failed" ? "failed: " + (view.lastFailure ?? "an unexpected error") : (view.lastStatus ?? "")) : "None yet";
  return (
    <Card id="news" role="region" aria-labelledby="news-title" data-testid="news-section" className="min-w-0 scroll-mt-24">
      <h2 id="news-title" className="font-heading text-card-title font-semibold text-foreground">
        GovCon news
      </h2>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-body sm:grid-cols-[14rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Status</dt>
        <dd data-testid="news-status">{on ? "Configured" : "Not configured"}</dd>
        <dt className="text-muted-foreground">Web category in the lane policy</dt>
        <dd data-testid="news-web">{view.webAllowed ? "On" : "Off"}</dd>
        <dt className="text-muted-foreground">News switched on (lane config)</dt>
        <dd data-testid="news-enabled">{view.enabled ? "Yes" : "No"}</dd>
        <dt className="text-muted-foreground">Spend this month (estimate)</dt>
        <dd data-testid="news-spend">{usd(view.monthSpendUsd) + " of " + usd(view.capUsd) + " · " + fetches}</dd>
        <dt className="text-muted-foreground">Last fetch</dt>
        <dd data-testid="news-last">{last}</dd>
      </dl>
      {on ? null : (
        <p data-testid="news-setup-hint" className="mt-3 text-small text-muted-foreground">
          An administrator turns news on for this company.
        </p>
      )}
    </Card>
  );
}
