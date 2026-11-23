// Settings -> Approvals and Assistant (T-271): the two pages that left the side menu are reached from here until their final place is
// decided (Saurabh, Nov 23, 2026). Get started / AI brain is the "AI brain" section below. Only links: each page runs its own checks.
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, laneHref, navItem, type NavKey } from "@nichols/ui";

const TEXT: Partial<Record<NavKey, string>> = {
  approvals: "Email drafts and other actions waiting for your approval. Nothing is sent or changed until you approve it.",
  assistant: "Ask questions about this company's connected sources.",
};

/** "Approvals and Assistant", or just the one a company shows. Also the label of the Settings sub-navigation entry. */
export function settingsPagesTitle(pages: readonly NavKey[]): string {
  return pages.map((key) => navItem(key).label).join(" and ");
}

export function SettingsPagesSection({ laneId, pages }: { laneId: string; pages: readonly NavKey[] }) {
  if (pages.length === 0) return null;
  const title = settingsPagesTitle(pages);
  return (
    <section id="pages" aria-labelledby="pages-title" className="scroll-mt-8">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="pages-title">
            {title}
          </CardTitle>
          <CardDescription>These pages are opened from here.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-divider" data-testid="settings-pages">
            {pages.map((key) => {
              const item = navItem(key);
              return (
                <li key={key}>
                  <Link href={laneHref(laneId, item.segment)} className="flex min-h-11 flex-col justify-center gap-0.5 py-3 hover:underline">
                    <span className="text-body font-medium text-primary">{item.label}</span>
                    {TEXT[key] ? <span className="text-small text-muted-foreground">{TEXT[key]}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
