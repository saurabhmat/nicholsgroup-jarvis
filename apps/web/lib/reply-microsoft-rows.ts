// T-262: which Microsoft connections of a viewer's Home rows may be replied to: the connection holds `graph_mail_write` (Mail.ReadWrite and Mail.Send were granted at the last
// connect), is usable, and the lane policy allows an email write. Everything else stays "Reply is not available for this mailbox yet" (fail closed: an unreadable fact excludes the
// connection). Only Microsoft connections are looked at; Google rows are never affected. Presentation only: the reply routes check the same rule server-side (`assertReplyAllowed`).
import type { ApprovalsPublicDeps } from "@nichols/approvals/server";

export async function replyableMicrosoftConnections(approvals: Pick<ApprovalsPublicDeps, "readFacts">, laneId: string, sourceOf: Readonly<Record<string, { provider: string }>> | undefined): Promise<ReadonlySet<string>> {
  const ok = new Set<string>();
  const ids = Object.entries(sourceOf ?? {}).filter(([, tag]) => tag.provider === "microsoft").map(([id]) => id);
  await Promise.all(
    ids.map(async (id) => {
      try {
        const f = await approvals.readFacts(laneId as never, id);
        if (f.mailbox !== null && f.provider === "microsoft" && f.composeGranted && f.writeActionsAllowed.some((a) => a === "email_send" || a === "email_draft")) ok.add(id);
      } catch {
        // unreadable: not replyable
      }
    }),
  );
  return ok;
}
