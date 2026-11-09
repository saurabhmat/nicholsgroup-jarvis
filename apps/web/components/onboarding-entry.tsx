// The two phone entry points to the onboarding (T-226): the Home banner while setup is incomplete and the first row of More.
// `progress` is null for anyone without the brain view: nothing is drawn.
import Link from "next/link";
import { Badge, laneHref, onboardingEntry } from "@nichols/ui";
import type { OnboardingView } from "@/lib/onboarding";

type Progress = Pick<OnboardingView, "done" | "total"> | null;

export function OnboardingBanner({ laneId, progress }: { laneId: string; progress: Progress }) {
  if (!progress || progress.done === null || progress.done >= progress.total) return null;
  return (
    <Link
      href={laneHref(laneId, "onboarding")}
      data-testid="onboarding-banner"
      className="flex items-center justify-between gap-3 rounded-card border border-border border-l-[3px] border-l-gold bg-card h-[3.25rem] px-4 text-body font-medium text-foreground hover:bg-muted md:hidden"
    >
      <span>
        Finish setting up Jarvis ({progress.done} of {progress.total}) <span aria-hidden>→</span>
      </span>
    </Link>
  );
}

/** The More row: "Get started" with its badge, or "AI brain" with a check when everything is done. */
export function OnboardingMoreRow({ laneId, progress }: { laneId: string; progress: Progress }) {
  if (!progress) return null;
  const entry = onboardingEntry(progress);
  return (
    <li>
      <Link className="flex items-center justify-between gap-3 px-4 py-3 text-body" href={laneHref(laneId, "onboarding")}>
        <span className="flex items-center gap-2">
          {entry.label}
          {entry.complete ? <span role="img" aria-label="Setup complete">✓</span> : null}
        </span>
        {entry.badge ? <Badge variant="gold">{entry.badge}</Badge> : null}
      </Link>
    </li>
  );
}
