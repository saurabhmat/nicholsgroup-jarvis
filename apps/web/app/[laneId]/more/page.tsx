// iPhone "More" tab: the menu entries that have no tab of their own, and sign-out. A tab page, so no back link.
// T-271: Get started / AI brain, Approvals and Assistant are reached from Settings (the last row here), as on the desktop.
import { SignOutForm } from "@/components/sign-out-form";
import Link from "next/link";
import { Button, laneHref, MORE_ITEMS, navItem, PageHeader } from "@nichols/ui";
import { MessagesDot } from "@/components/messages-dot";
import { ThemeToggle } from "@/components/theme-toggle";
import { loadLane } from "@/lib/lane-page";
import { hiddenNavKeys, laneGate } from "@/lib/lane-modules";
import { signOut } from "../../sign-in/actions";

export default function Page(props: PageProps<"/[laneId]/more">) {
  return <More params={props.params} />;
}

async function More({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const hidden = hiddenNavKeys(await laneGate(lane.laneId));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={lane.name} title="More" />
      <ul className="flex flex-col divide-y divide-divider rounded-card border border-border bg-card">
        {MORE_ITEMS.filter((key) => key === "settings" || !hidden.includes(key)).map((key) => {
          const item = navItem(key);
          return (
            <li key={key}>
              <Link className="flex items-center gap-2 px-4 py-3 text-body" href={laneHref(lane.laneId, item.segment)}>
                {item.label}
                {/* T-290: the "new messages" dot, fetched in the browser after the page rendered (nothing is read here) */}
                {key === "messages" ? <MessagesDot laneId={lane.laneId} /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <ThemeToggle />
      <SignOutForm action={signOut}>
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </SignOutForm>
    </div>
  );
}
