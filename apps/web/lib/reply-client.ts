// Browser side of the Reply drawer (T-234 part 3): one call helper for the approvals route and the shapes it answers with.
// Type-only imports from the server code (erased), so nothing server-side reaches the bundle.
import type { ReplyContext, DraftResult } from "./reply";
import type { ReplyOutcome } from "./reply-messages";

export type { ReplyContext, DraftResult, ReplyOutcome };

export type ReplyCall = { status: number; data: Record<string, unknown> };

export async function callApprovals(laneId: string, payload: Record<string, unknown>): Promise<ReplyCall> {
  try {
    const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}/approvals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return { status: res.status, data: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
  } catch {
    return { status: 0, data: {} };
  }
}

export const GENERIC_ERROR = "That did not work. Check your connection and try again.";
/** The server's fixed message for a refusal, else a generic line. */
export const errorText = (c: ReplyCall): string => (typeof c.data.message === "string" && c.data.message !== "" ? c.data.message : GENERIC_ERROR);

/** Where to send the owner for a fresh authenticator code, coming back with this drawer open. */
export const stepUpHref = (laneId: string, messageId: string): string => `/mfa?reauth=1&next=${encodeURIComponent(`/${laneId}?reply=${encodeURIComponent(messageId)}`)}`;

const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export const splitAddresses = (s: string): string[] => s.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x !== "");
export const invalidAddresses = (list: readonly string[]): string[] => list.filter((a) => !ADDRESS.test(a));
