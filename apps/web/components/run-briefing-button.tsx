"use client";
// "Run now" (T-231c): prepares a new briefing on the server; the page refreshes when it is saved. Codes only.
import { useActionState } from "react";
import { buttonVariants } from "@nichols/ui";
import { runBriefingNow, type RunNowState } from "@/app/[laneId]/briefing-actions";

const MESSAGES: Record<string, string> = {
  forbidden: "Only the owner can prepare the briefing.",
  not_configured: "The AI is not set up for this deployment yet.",
  too_soon: "A briefing was prepared in the last 2 minutes.",
  unavailable: "The briefing could not be prepared. Try again in a minute.",
};

export function RunBriefingButton({ laneId }: { laneId: string }) {
  const [state, action, pending] = useActionState<RunNowState, FormData>(() => runBriefingNow(laneId), null);
  return (
    <form action={action} className="flex items-center gap-2">
      <button type="submit" disabled={pending} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid="run-briefing">
        {pending ? "Preparing…" : "Run now"}
      </button>
      {state && "error" in state ? (
        <span role="status" className="text-small text-muted-foreground">
          {MESSAGES[state.error]}
        </span>
      ) : null}
    </form>
  );
}
