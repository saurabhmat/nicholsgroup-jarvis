// What the AI summary may do to "Needs your attention" (T-243). Pure.
//
// The list is ranked by RULES over metadata (attention.ts). The summary (AI output, rule 9: untrusted) can only take things AWAY from
// that list, never add to it, reorder it, change a figure or reach a permission:
//   * an item whose latest message the summary marks `needs_reply: false` ("no reply needed") leaves the list; the next fresh item the
//     rules ranked moves up into the top 5 (it was already ranked, nothing is invented);
//   * "Waiting on you" is not shown on a row whose note says nothing is needed.
// Security alerts, VIP / priority mail, money and deadline rows are never removed by a note (isProtectedRow): the summary may only hide their
// "Waiting on you" chip. A note applies to exactly the message it summarized (connection + message id, and the thread key when both sides have one): a newer
// message in the same thread is not covered by an older summary. A briefing without the field (saved earlier) means unknown: nothing changes.
import type { AttentionThread } from "./attention";
import type { AttentionNote, BriefRef } from "./compose";

export type SummaryForAttention = { status: string; refs: readonly BriefRef[]; content: { attention: readonly AttentionNote[] } };

const keyOf = (connectionId: string, messageId: string) => `${connectionId}:${messageId}`;

/** The notes of a briefing by `connectionId:messageId` (the message the summary was written for). Empty for a failed or missing briefing. */
export function notesForMessages(saved: SummaryForAttention | null | undefined): Map<string, AttentionNote> {
  const out = new Map<string, AttentionNote>();
  if (!saved || saved.status === "failed") return out;
  const byRef = new Map(saved.refs.map((r) => [r.ref, r]));
  for (const a of saved.content.attention) {
    const r = byRef.get(a.ref);
    if (r) out.set(keyOf(r.connectionId, r.messageId), a);
  }
  return out;
}

/**
 * Rows the summary can never remove (rules 7 and 9: the summary is untrusted AI output, and an injected message could make it say "no reply
 * needed" about mail that matters): security alerts, VIP / priority mail, money, deadlines, and rule-made repeated-failure rows. For these a
 * no-reply note may still hide the "Waiting on you" chip, never the row.
 */
export const isProtectedRow = (item: AttentionThread): boolean =>
  item.kind === "repeated_failures" || item.kind === "security" || item.kind === "priority" || item.flags.vip || item.flags.money !== null || item.flags.deadline;

/** True when the summary says this exact thread message needs no reply and the row may be removed. When two refs map to one message, a `true` wins. */
export function summaryMarksNoReply(item: AttentionThread, saved: SummaryForAttention | null | undefined): boolean {
  if (isProtectedRow(item) || !saved || saved.status === "failed") return false;
  const t = item.thread;
  const byRef = new Map(saved.refs.map((r) => [r.ref, r]));
  const same = saved.content.attention.filter((a) => {
    const r = byRef.get(a.ref);
    return r !== undefined && r.connectionId === t.connectionId && r.messageId === t.messageId && (r.threadKey === "" || r.threadKey === t.threadKey);
  });
  return same.length > 0 && same.some((a) => a.needsReply === false) && !same.some((a) => a.needsReply === true);
}

/**
 * The top list after removing the summary's "no reply needed" items. `fresh` is the rules' full ranked list of fresh threads; the result
 * is a subset of it in the same order, `limit` long at most, and `more` counts the rest still needing attention (removed items are not counted).
 */
export function dropNoReplyItems(fresh: readonly AttentionThread[], saved: SummaryForAttention | null | undefined, limit = 5): { top: AttentionThread[]; more: number; removed: number; kept: AttentionThread[] } {
  const kept = fresh.filter((a) => !summaryMarksNoReply(a, saved));
  return { top: kept.slice(0, limit), more: Math.max(0, kept.length - limit), removed: fresh.length - kept.length, kept };
}

/** The summary says "nothing is needed" in words (an older briefing without needs_reply). Used only to HIDE the "Waiting on you" chip. */
const NO_ACTION_TEXT = /\b(?:no|not any)\s+(?:further\s+|more\s+)?(?:action|reply|response|follow[- ]?up)\s+(?:is\s+|are\s+)?(?:needed|required|necessary)\b|\bnothing\s+(?:is\s+)?(?:needed|required)\b|\bno\s+need\s+to\s+(?:reply|respond|act)\b/i;

/** True when the note (or its needs_reply field) says the owner has nothing to do. Never used to show or add anything. */
export function noteSaysNoAction(note: AttentionNote | undefined): boolean {
  if (!note) return false;
  if (note.needsReply === false) return true;
  if (note.needsReply === true) return false;
  return NO_ACTION_TEXT.test(`${note.what} ${note.why} ${note.next}`);
}
