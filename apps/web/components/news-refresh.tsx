"use client";
// "Refresh" on the GovCon news card (T-234 part 4): owner only (the server renders it only for the owner). One press = one
// server action call (refreshNews), which the database limits to once an hour and under the monthly cap. Nothing runs on
// render, on focus or on the 5-minute page refresh. `disabledReason` is computed by the server from stored state.
import { useActionState } from "react";
import { buttonVariants } from "@nichols/ui";
import { refreshNews } from "@/app/[laneId]/news-actions";
import { newsFailureText, type RefreshNewsState } from "@/lib/news-types";

const MESSAGES: Record<string, string> = {
  forbidden: "Only the owner can refresh the news.",
  not_configured: "News is not configured.",
  cap_reached: "Monthly news budget reached",
  rate_limited: "Refresh is limited to once an hour.",
  busy: "A refresh is already running.",
  ai_not_set_up: "The AI is not set up for this deployment yet.",
  unavailable: "The news could not be refreshed. Try again in a minute.",
};

export function NewsRefresh({ laneId, disabledReason }: { laneId: string; disabledReason: string | null }) {
  const [state, action, pending] = useActionState<RefreshNewsState, FormData>(() => refreshNews(laneId), null);
  const disabled = pending || disabledReason !== null;
  const succeeded = state !== null && "ok" in state && (state.status === "ok" || state.status === "partial");
  const note = pending
    ? "Fetching news…"
    : succeeded
      ? "Updated just now"
      : (disabledReason ?? (state && "error" in state ? (MESSAGES[state.error] ?? MESSAGES.unavailable) : state?.failure ? `News could not be fetched: ${newsFailureText(state.failure)}` : null));
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-testid="news-refresh-form">
      <button type="submit" disabled={disabled} aria-describedby={note ? "news-refresh-note" : undefined} className={`${buttonVariants({ variant: "outline", size: "sm" })} max-md:min-h-11`} data-testid="news-refresh">
        {pending ? "Refreshing…" : "Refresh"}
      </button>
      {note ? (
        <span id="news-refresh-note" role="status" data-testid="news-refresh-note" className="text-small text-muted-foreground">
          {note}
        </span>
      ) : null}
    </form>
  );
}
