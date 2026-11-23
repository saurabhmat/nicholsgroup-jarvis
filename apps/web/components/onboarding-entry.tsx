// The phone entry point to the onboarding (T-226): the Home banner while setup is incomplete. (T-271: the More row is gone; setup is
// reached from Settings -> AI brain.)
// `progress` is null for anyone without the brain view: nothing is drawn.
import Link from "next/link";
import { laneHref } from "@nichols/ui";
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
