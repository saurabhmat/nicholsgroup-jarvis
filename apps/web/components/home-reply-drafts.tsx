// Reply drafts on Home (T-231d). Up to 3 drafts from today's briefing: thread, recipient, status, context note, the
// copy-ready text and a Copy button; each also sits in Approvals as an email.send proposal (editable there, never sent
// without approval). Further threads needing a reply are listed by name. Recipient, subject and links come from the
// stored refs (mail metadata), never from the model; model text is plain text (React escapes it).
import Link from "next/link";
import { Badge, laneHref, PageSection } from "@nichols/ui";
import { formatDateTimeIn, maskFigures, type BriefRef } from "@nichols/briefing/domain";
import type { SavedBriefingView } from "@/lib/briefing";
import { CopyTextButton } from "./copy-text-button";

export const REPLY_STATUS = {
  ready: { label: "Ready for your review", variant: "success" },
  awaiting_input: { label: "Awaiting your input", variant: "outline" },
} as const;

export function ReplyDrafts({ laneId, brief, tz }: { laneId: string; brief: SavedBriefingView | null; tz: string }) {
  if (!brief || brief.status === "failed") return null;
  const { replies, moreReplies, notes } = brief.content;
  if (replies.length === 0 && moreReplies.length === 0) {
    // Say why there are none when the lane does not keep drafts (D-19), so an empty card is never read as "nothing to answer".
    return notes.includes("reply_drafts_off") ? (
      <PageSection title="Reply drafts" note="From today's briefing">
        <p className="text-body text-muted-foreground">Reply drafts are off for this company (outbound drafts are not stored).</p>
      </PageSection>
    ) : null;
  }
  const byRef = new Map(brief.refs.map((r) => [r.ref, r]));
  const nameOf = (r: BriefRef | undefined) => r?.fromName ?? r?.fromAddress ?? "Unknown sender";
  const more = moreReplies.flatMap((ref) => (byRef.has(ref) ? [nameOf(byRef.get(ref))] : []));
  return (
    <PageSection title="Reply drafts" note="From today's briefing · never sent without your approval">
      <ul data-testid="reply-drafts" className="flex flex-col divide-y divide-border">
        {replies.map((d) => {
          const r = byRef.get(d.ref);
          const s = REPLY_STATUS[d.status];
          return (
            <li key={d.ref} data-testid="reply-draft" className="flex flex-col gap-2 py-3 text-body">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-foreground">{r?.subject ? maskFigures(r.subject) : "(no subject)"}</span>
                <Badge variant={s.variant}>{s.label}</Badge>
              </div>
              <span className="text-small text-muted-foreground">
                {[`To ${r?.fromAddress ?? "unknown"}`, r?.mailbox ? `from ${r.mailbox}` : null, r?.receivedAt ? `received ${formatDateTimeIn(r.receivedAt, tz)}` : null].filter(Boolean).join(" · ")}
                {r?.sourceUrl ? (
                  <>
                    {" · "}
                    <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                      Open thread
                    </a>
                  </>
                ) : null}
              </span>
              {d.context ? <p className="text-small text-muted-foreground">{d.context}</p> : null}
              {d.text ? (
                <pre data-testid="reply-text" className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-sans text-body text-foreground">
                  {d.text}
                </pre>
              ) : (
                <p className="text-small text-muted-foreground">No text yet: this one needs your decision first.</p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {d.text ? <CopyTextButton text={d.text} /> : null}
                {d.proposalId ? (
                  <Link href={`${laneHref(laneId, "approvals")}#action-${d.proposalId}`} className="text-small text-primary underline-offset-2 hover:underline">
                    Review in Approvals
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {more.length > 0 ? (
        <p data-testid="more-replies" className="mt-2 text-small text-muted-foreground">
          Also waiting for a reply: {more.join(", ")}
        </p>
      ) : null}
    </PageSection>
  );
}
