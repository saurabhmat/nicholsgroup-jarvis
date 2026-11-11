// AI briefing on Home (T-231c): Today's briefing (3-5 lines) with "prepared at" and the review window, Deadlines and
// follow-ups, Top 3 priorities, and the what/why/next notes merged into "Needs your attention". All model text is plain
// text (React escapes it); sources and links come from the stored refs (metadata), never from the model.
import { Badge, PageSection } from "@nichols/ui";
import { formatDateTimeIn, maskFigures, type AttentionNote, type BriefRef } from "@nichols/briefing/domain";
import type { SavedBriefingView } from "@/lib/briefing";
import { RunBriefingButton } from "./run-briefing-button";

const STATUS: Record<SavedBriefingView["status"], { label: string; variant: "success" | "outline" | "alert" }> = {
  ready: { label: "Ready", variant: "success" },
  partial: { label: "Partial: see Coverage", variant: "outline" },
  failed: { label: "Could not be prepared", variant: "alert" },
};

export function AiBriefing({ laneId, brief, fallbackLines, tz, canRun }: { laneId: string; brief: SavedBriefingView | null; fallbackLines: string[]; tz: string; canRun: boolean }) {
  const lines = brief && brief.status !== "failed" && brief.content.lines.length > 0 ? brief.content.lines : null;
  return (
    <section aria-label="Today's briefing" className="relative overflow-hidden rounded-card border border-border bg-card p-5 text-card-foreground shadow-card sm:p-6">
      <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gold" />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-card-title font-semibold text-foreground">Today&apos;s briefing</h2>
        <div className="flex flex-wrap items-center gap-3">
          {brief ? (
            <span data-testid="briefing-prepared" className="text-small text-muted-foreground">
              {brief.status === "failed" ? "Last attempt" : "Prepared"} {formatDateTimeIn(brief.preparedAt, tz)}
              {brief.status === "failed" ? null : ` · mail reviewed ${formatDateTimeIn(brief.windowFrom, tz)} – ${formatDateTimeIn(brief.windowTo, tz)}`}
            </span>
          ) : (
            <span className="text-small text-muted-foreground">From your connected sources</span>
          )}
          {brief ? <Badge variant={STATUS[brief.status].variant}>{STATUS[brief.status].label}</Badge> : null}
          {canRun ? <RunBriefingButton laneId={laneId} /> : null}
        </div>
      </div>
      {brief && brief.status !== "failed" && brief.lastFailedAt ? (
        <p data-testid="briefing-last-failed" className="mt-2 text-small text-muted-foreground">
          A newer attempt at {formatDateTimeIn(brief.lastFailedAt, tz)} could not be prepared; this is the last good briefing.
        </p>
      ) : null}
      {lines ? (
        <ul data-testid="briefing" className="mt-3 flex max-w-4xl list-disc flex-col gap-1 pl-5 text-body leading-relaxed text-foreground">
          {lines.map((l, i) => (
            <li key={String(i)}>{l}</li>
          ))}
        </ul>
      ) : fallbackLines.length > 0 ? (
        <p data-testid="briefing" className="mt-3 max-w-4xl text-body leading-relaxed text-foreground">
          {fallbackLines.join(" ")}
        </p>
      ) : (
        <p className="mt-3 text-body text-muted-foreground">Your briefing appears here once this company&apos;s sources are connected.</p>
      )}
    </section>
  );
}

const refLink = (r: BriefRef | undefined) =>
  r?.sourceUrl ? (
    <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-small text-primary underline-offset-2 hover:underline">
      Open thread
    </a>
  ) : null;

export function DeadlinesAndPriorities({ brief, tz }: { brief: SavedBriefingView | null; tz: string }) {
  if (!brief || brief.status === "failed") return null;
  const byRef = new Map(brief.refs.map((r) => [r.ref, r]));
  const { deadlines, priorities } = brief.content;
  return (
    <>
      <PageSection title="Top 3 priorities" note="From today's briefing">
        {priorities.length === 0 ? (
          <p className="text-body text-muted-foreground">No priorities could be drawn from what was read.</p>
        ) : (
          <ol data-testid="priorities" className="flex list-decimal flex-col gap-2 pl-5 text-body">
            {priorities.map((p, i) => (
              <li key={String(i)}>
                <span className="font-medium text-foreground">{p.text}</span>
                <span className="block text-small text-muted-foreground">{p.reason}</span>
              </li>
            ))}
          </ol>
        )}
      </PageSection>
      <PageSection title="Deadlines and follow-ups" note="From today's briefing">
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
                      {refLink(r)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </PageSection>
    </>
  );
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
