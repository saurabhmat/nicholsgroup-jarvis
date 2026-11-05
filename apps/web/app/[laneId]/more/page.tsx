// iPhone "More" tab: the menu entries that have no tab of their own, and sign-out. A tab page, so no back link.
import Link from "next/link";
import { Suspense } from "react";
import { Button, laneHref, MORE_ITEMS, navItem, PageHeader } from "@nichols/ui";
import { ThemeToggle } from "@/components/theme-toggle";
import { loadLane } from "@/lib/lane-page";
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
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="More" />
      <ul className="flex flex-col divide-y divide-divider rounded-card border border-border bg-card">
        {MORE_ITEMS.map((key) => {
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
