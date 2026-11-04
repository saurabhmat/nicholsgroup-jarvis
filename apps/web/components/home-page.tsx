// Home (D-20 batch 1, p3 and p6): header with the date and company, the Ask Jarvis button and the section skeletons as
// empty states. Built to the prototype's structure; the briefing, figures and lists arrive in T-163.
import Link from "next/link";
import { buttonVariants, homeHeading, laneHref, PageHeader, PageSection } from "@nichols/ui";
import { eyebrowDate } from "@/lib/format-date";
import { loadLane } from "@/lib/lane-page";

export async function HomePage({ params }: { params: Promise<{ laneId: string }> }) {
  const lane = await loadLane((await params).laneId);
  const heading = homeHeading(); // no first name in the session yet: "Good morning"
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${eyebrowDate(new Date())} · ${lane.name}`}
        title={heading.lead}
        accent={heading.accent}
        actions={
          <Link href={laneHref(lane.laneId, "assistant")} className={buttonVariants()}>
            Ask Jarvis
          </Link>
        }
      />
      <PageSection title="Today's briefing" emptyTitle="No briefing yet" emptyDescription="Your daily briefing appears here once the company's sources are connected." />
      <div className="grid gap-6 lg:grid-cols-2">
        <PageSection title="Needs your attention" emptyTitle="Nothing to show yet" emptyDescription="Approvals, feed problems and the next meeting appear here." />
        <PageSection title="Today's meetings" emptyTitle="No calendar connected" emptyDescription="Today's meetings appear here once a calendar is connected." />
      </div>
      <PageSection title="Projects at a glance" emptyTitle="No project board connected" emptyDescription="Project status appears here, read-only, once the project board is connected." />
    </div>
  );
}
