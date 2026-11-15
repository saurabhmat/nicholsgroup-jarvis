"use client";
// "Refresh" on the GovCon news card (T-234 part 4): owner only (the server renders it only for the owner). One press = one
// server action call (refreshNews), which the database limits to once an hour and under the monthly cap. Nothing runs on
// render, on focus or on the 5-minute page refresh. `disabledReason` is computed by the server from stored state.
// T-249: the fetch runs in the background (the action answers "started" at once). While the server reports a fetch in flight
// (`inFlight`), the card re-reads the page every NEWS_POLL_MS (at most NEWS_POLL_MAX_MS, then a fixed "reload later" note), so the stories or the failure reason
// appear by themselves; the poll only reads the stored digest and never starts a fetch.
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { buttonVariants } from "@nichols/ui";
import { refreshNews } from "@/app/[laneId]/news-actions";
import { NEWS_POLL_MAX_MS, NEWS_POLL_MS, NEWS_STALLED_NOTE, NEWS_STARTED_NOTE, newsFailureText, type RefreshNewsState } from "@/lib/news-types";

const MESSAGES: Record<string, string> = {
  forbidden: "Only the owner can refresh the news.",
  not_configured: "News is not configured.",
  cap_reached: "Monthly news budget reached",
  rate_limited: "Refresh is limited to once an hour.",
  busy: "A refresh is already running.",
  ai_not_set_up: "The AI is not set up for this deployment yet.",
  unavailable: "The news could not be refreshed. Try again in a minute.",
};

export function NewsRefresh({ laneId, disabledReason, inFlight = false }: { laneId: string; disabledReason: string | null; inFlight?: boolean }) {
  const [state, action, pending] = useActionState<RefreshNewsState, FormData>(() => refreshNews(laneId), null);
  const router = useRouter();
  const started = state !== null && "ok" in state && state.status === "started";
  const [stalled, setStalled] = useState(false);
  // Poll only for a fetch this press started and only while the server still reports it in flight.
  useEffect(() => {
    if (!started || !inFlight) return;
    const tick = setInterval(() => router.refresh(), NEWS_POLL_MS);
    const stop = setTimeout(() => {
      clearInterval(tick);
      setStalled(true);
    }, NEWS_POLL_MAX_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [started, inFlight, router]);
  const disabled = pending || disabledReason !== null;
  const succeeded = state !== null && "ok" in state && (state.status === "ok" || state.status === "partial");
  const note = pending
    ? "Starting…"
    : started && inFlight
      ? stalled
        ? NEWS_STALLED_NOTE
        : NEWS_STARTED_NOTE
      : succeeded
        ? "Updated just now"
        : (disabledReason ?? (state && "error" in state ? (MESSAGES[state.error] ?? MESSAGES.unavailable) : state?.failure ? `News could not be fetched: ${newsFailureText(state.failure)}` : null));
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-testid="news-refresh-form">
      <button type="submit" disabled={disabled} aria-describedby={note ? "news-refresh-note" : undefined} className={`${buttonVariants({ variant: "outline", size: "sm" })} max-md:min-h-11`} data-testid="news-refresh">
        {pending || (started && inFlight) ? "Refreshing…" : "Refresh"}
      </button>
      {note ? (
        <span id="news-refresh-note" role="status" data-testid="news-refresh-note" className="text-small text-muted-foreground">
          {note}
        </span>
      ) : null}
    </form>
  );
}
