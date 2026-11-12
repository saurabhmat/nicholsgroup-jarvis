// AI briefing on Home (T-231c; T-234 part 2: merged into "Needs your attention"): the summary (first 2 lines of the briefing, the rest
// behind "More"), "Summary at <time>" plus the owner's controls (T-235: Updating summary…, the ⋯ menu; no Run button), the Top 3 priorities as a compact numbered row, the deadlines list (folded), and the
// why/next notes shown on the attention items. All model text is plain text (React escapes it); sources and links come from the
// stored refs (metadata), never from the model.
import Link from "next/link";
import { Badge } from "@nichols/ui";
import { inboxHref } from "@/lib/inbox-links";
import { formatDateTimeIn, maskFigures, type AttentionNote, type BriefRef } from "@nichols/briefing/domain";
import type { FailureCode } from "@nichols/briefing/domain";
import type { SavedBriefingView } from "@/lib/briefing";
import { FailureReason } from "./briefing-failure";
import type { ReactNode } from "react";
import { newsTime } from "./home-news";
import { PersistedDetails } from "./home-scope";

const STATUS: Record<SavedBriefingView["status"], { label: string; variant: "success" | "outline" | "alert" }> = {
  ready: { label: "Ready", variant: "success" },
  partial: { label: "Partial: see Settings → Connections", variant: "outline" },
  failed: { label: "Could not be prepared", variant: "alert" },
};

/** "EST" / "PST" for the zone at that moment; the zone name when the runtime has no short name. */
function zoneAbbr(tz: string, iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

/** The summary is the first two lines of the briefing (1-2 sentences); the rest sits behind "More from the briefing". */
const SUMMARY_LINES = 2;

/**
 * The top of "Needs your attention" (T-234 part 2): the AI summary, "Summary at <time>" with the owner's `controls` (T-235), and the Top 3 priorities as a
 * compact numbered row. Without an AI briefing (none yet, failed, or not configured) the rule-based sentence takes its place with
 * "AI summary unavailable: <reason>".
 * `failure`: why the newest attempt (or the AI setup) failed, a fixed code; `failureHint`: the admin hint, set server-side only for owner or admin_technical.
 */
export function AiBriefing({ brief, fallbackLines, tz, controls = null, now = new Date(), failure = null, failureHint = null }: { laneId?: string; brief: SavedBriefingView | null; fallbackLines: string[]; tz: string; controls?: ReactNode; now?: Date; failure?: FailureCode | null; failureHint?: string | null }) {
  const lines = brief && brief.status !== "failed" && brief.content.lines.length > 0 ? brief.content.lines : null;
  const priorities = brief && brief.status !== "failed" ? brief.content.priorities : [];
  return (
    <div data-testid="ai-briefing" className="flex flex-col gap-3 border-b border-border pb-4">
      {lines ? (
        <div className="max-w-4xl">
          <p data-testid="briefing" className="text-body leading-relaxed text-foreground">
            {lines.slice(0, SUMMARY_LINES).join(" ")}
          </p>
          {lines.length > SUMMARY_LINES ? (
            <PersistedDetails id="briefing-more" testId="briefing-more" className="mt-1 text-small" summaryClassName="cursor-pointer text-primary" summary="More from the briefing">
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-body leading-relaxed text-foreground">
                {lines.slice(SUMMARY_LINES).map((l, i) => (
                  <li key={String(i)}>{l}</li>
                ))}
              </ul>
            </PersistedDetails>
          ) : null}
        </div>
      ) : fallbackLines.length > 0 ? (
        <p data-testid="briefing" className="max-w-4xl text-body leading-relaxed text-foreground">
          {fallbackLines.join(" ")}
        </p>
      ) : (
        <p className="text-body text-muted-foreground">Your briefing appears here once this company&apos;s sources are connected.</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {brief ? (
          <span data-testid="briefing-prepared" className="text-small text-muted-foreground" title={[brief.status === "failed" ? null : `Mail reviewed ${formatDateTimeIn(brief.windowFrom, tz)} – ${formatDateTimeIn(brief.windowTo, tz)}`, `Times in ${zoneAbbr(tz, brief.preparedAt)}`].filter(Boolean).join(" · ")}>
            {brief.status === "failed" ? "Last attempt" : "Summary at"} {brief.status === "failed" ? formatDateTimeIn(brief.preparedAt, tz) : newsTime(brief.preparedAt, tz, now)}
          </span>
        ) : (
          <span className="text-small text-muted-foreground">From your connected sources</span>
        )}
        {brief && brief.status === "partial" ? <Badge variant={STATUS.partial.variant}>{STATUS.partial.label}</Badge> : null}
        {controls}
      </div>
      {brief && brief.status !== "failed" && brief.lastFailedAt ? (
        <p data-testid="briefing-last-failed" className="text-small text-muted-foreground">
          A newer attempt at {formatDateTimeIn(brief.lastFailedAt, tz)} could not be prepared; this is the last good briefing.
        </p>
      ) : null}
      {!lines && (failure || (brief && (brief.status === "failed" || brief.lastFailedAt))) ? (
        <p>
          <FailureReason code={failure} hint={failureHint} />
        </p>
      ) : lines && failure ? (
        <p>
          <FailureReason code={failure} hint={failureHint} prefix="Newest attempt not prepared" />
        </p>
      ) : null}
      {priorities.length > 0 ? (
        <div data-testid="priorities-row" className="flex flex-col gap-1">
          <span className="text-small font-medium text-muted-foreground">Top {priorities.length === 1 ? "priority" : String(priorities.length)}</span>
          <ol data-testid="priorities" className="grid gap-x-4 gap-y-1 text-small sm:grid-cols-3">
            {priorities.map((p, i) => (
              <li key={String(i)} className="flex min-w-0 gap-2" title={p.reason}>
                <span aria-hidden className="font-semibold text-muted-foreground">
                  {String(i + 1)}.
                </span>
                <span className="min-w-0 break-words text-foreground">{p.text}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** "Open thread" goes to the thread in Jarvis (the stored provider link is not used: it left Jarvis for a Google page). */
const refLink = (laneId: string, r: BriefRef | undefined) =>
  r ? (
    <Link href={inboxHref(laneId, r.messageId)} className="text-small text-primary underline-offset-2 hover:underline">
      Open thread
    </Link>
  ) : null;

/** Deadlines and follow-ups from today's briefing (folded under "Drafts and deadlines" on Home). */
export function Deadlines({ laneId, brief, tz }: { laneId: string; brief: SavedBriefingView | null; tz: string }) {
  if (!brief || brief.status === "failed") return null;
  const byRef = new Map(brief.refs.map((r) => [r.ref, r]));
  const { deadlines } = brief.content;
  return (
    <section aria-label="Deadlines and follow-ups" className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-foreground">Deadlines and follow-ups</h3>
      {deadlines.length === 0 ? (
        <p className="text-body text-muted-foreground">No deadlines or follow-ups in what was read.</p>
      ) : (
        <ul data-testid="deadlines" className="flex flex-col divide-y divide-border">
          {deadlines.map((d, i) => {
            const r = d.ref ? byRef.get(d.ref) : undefined;
            return (
              <li key={String(i)} className="flex flex-col gap-1 py-2 text-body">
                <span className="text-foreground">
                  {d.text}
                  {d.due ? <span className="text-muted-foreground"> · due {d.due}</span> : null}
                </span>
                {r ? (
                  <span className="flex flex-wrap items-baseline gap-2 text-small text-muted-foreground">
                    {[r.mailbox, r.fromName ?? r.fromAddress, r.subject ? maskFigures(r.subject) : null, r.receivedAt ? formatDateTimeIn(r.receivedAt, tz) : null].filter(Boolean).join(" · ")}
                    {refLink(laneId, r)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Provider message -> the email.send proposal the briefing prepared (T-231d), for the Reply action. */
export function repliesByMessage(brief: SavedBriefingView | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!brief || brief.status === "failed") return out;
  const byRef = new Map(brief.refs.map((r) => [r.ref, r]));
  for (const d of brief.content.replies) {
    const r = byRef.get(d.ref);
    if (r && d.proposalId) out.set(`${r.connectionId}:${r.messageId}`, d.proposalId);
  }
  return out;
}

/** The AI note for one attention thread (matched by provider message id), shown under the rule-based item. */
export function notesByMessage(brief: SavedBriefingView | null): Map<string, AttentionNote> {
  const out = new Map<string, AttentionNote>();
  if (!brief || brief.status === "failed") return out;
  const byRef = new Map(brief.refs.map((r) => [r.ref, r]));
  for (const a of brief.content.attention) {
    const r = byRef.get(a.ref);
    if (r) out.set(`${r.connectionId}:${r.messageId}`, a);
  }
  return out;
}
