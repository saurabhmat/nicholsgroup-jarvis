// iPhone "More" tab: the menu entries that have no tab of their own, and sign-out. A tab page, so no back link.
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Button, laneHref, MORE_ITEMS, navItem, onboardingEntry, PageHeader } from "@nichols/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { loadLane } from "@/lib/lane-page";
import { onboardingFor } from "@/lib/onboarding-progress";
import { signOut } from "../../sign-in/actions";

export default function Page(props: PageProps<"/[laneId]/more">) {
  return (
    <Suspense fallback={null}>
      <More params={props.params} />
    </Suspense>
  );
}

async function More({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const onboarding = await onboardingFor(lane.laneId);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="More" />
      <ul className="flex flex-col divide-y divide-divider rounded-card border border-border bg-card">
        {MORE_ITEMS.filter((key) => key !== "onboarding" || onboarding).map((key) => {
          const item = navItem(key);
          const entry = key === "onboarding" && onboarding ? onboardingEntry({ done: onboarding.done, total: onboarding.total }) : null;
          return (
            <li key={key}>
              <Link className="flex items-center justify-between gap-3 px-4 py-3 text-sm" href={laneHref(lane.laneId, item.segment)}>
                <span className="flex items-center gap-2">
                  {entry ? entry.label : item.label}
                  {entry?.complete ? <span aria-label="Setup complete">✓</span> : null}
                </span>
                {entry?.badge ? <Badge variant="gold">{entry.badge}</Badge> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <ThemeToggle />
      <form action={signOut}>
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </div>
  );
}
