// "Projects at a glance" (T-235 part 5): until a project board is connected (the board arrives with the Projects task) it is
// one slim line, never a card with a placeholder. Admins get a Settings link; other roles just see the statement. Nothing is invented.
import Link from "next/link";
import { laneHref, SlimCard } from "@nichols/ui";

export function ProjectsGlance({ laneId = "", canConnect = false }: { laneId?: string; canConnect?: boolean }) {
  return (
    <SlimCard title="Projects at a glance" data-testid="projects-notice">
      <span>No project board connected</span>
      {canConnect && laneId ? (
        <>
          <span aria-hidden>{"\u00b7"}</span>
          <Link href={`${laneHref(laneId, "settings")}#connections`} className="font-medium text-primary underline underline-offset-2">
            Connect in Settings
          </Link>
        </>
      ) : null}
    </SlimCard>
  );
}
