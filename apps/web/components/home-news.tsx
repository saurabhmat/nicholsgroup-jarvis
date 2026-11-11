// GovCon news card (T-234 part 1 slot; part 4 fills it). Until the news fetch is configured for the lane it shows the
// fixed empty state "News not configured". Part 4 passes items (headline, why it matters, source, date, link; untrusted text).
import { PageSection } from "@nichols/ui";

export type NewsItem = { headline: string; why: string; source: string; date: string; url: string };

export function GovConNews({ items = null }: { items?: NewsItem[] | null }) {
  return (
    <PageSection title="GovCon news" note="Last 48 hours" className="h-full">
      {items && items.length > 0 ? (
        <ul data-testid="news-list" className="flex flex-col divide-y divide-border">
          {items.map((n) => (
            <li key={n.url} className="flex flex-col gap-1 py-3">
              <a href={n.url} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline-offset-2 hover:underline">
                {n.headline}
              </a>
              <span className="text-small text-foreground">{n.why}</span>
              <span className="text-small text-muted-foreground">{`${n.source} · ${n.date}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="news-empty" className="text-body text-muted-foreground">
          News not configured
        </p>
      )}
    </PageSection>
  );
}
