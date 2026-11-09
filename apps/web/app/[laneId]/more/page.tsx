// iPhone "More" tab: the menu entries that have no tab of their own, and sign-out. A tab page, so no back link.
import Link from "next/link";
import { Suspense } from "react";
import { Button, laneHref, MORE_ITEMS, navItem, PageHeader } from "@nichols/ui";
import { OnboardingMoreRow } from "@/components/onboarding-entry";
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
        <OnboardingMoreRow laneId={lane.laneId} progress={onboarding} />
        {MORE_ITEMS.filter((key) => key !== "onboarding").map((key) => {
          const item = navItem(key);
          return (
            <li key={key}>
              <Link className="block px-4 py-3 text-sm" href={laneHref(lane.laneId, item.segment)}>
                {item.label}
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
