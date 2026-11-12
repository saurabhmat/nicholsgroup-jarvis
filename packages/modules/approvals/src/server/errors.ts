// Errors of the approvals module (T-232): a fixed code and a fixed message only, never row text, SQL detail or the
// composed email (a message could be logged or shown). `toApprovalsError` maps the database's `act: <code>` messages.
export const APPROVALS_ERROR_CODES = [
  "invalid",
  "forbidden",
  "step_up_required",
  "not_found",
  "hash_mismatch",
  "not_live",
  "not_enabled",
  "already_approved",
  "not_pending",
  "expired",
  "not_editable",
  "drafts_not_allowed",
  "too_many_pending",
  "sender_mismatch",
  "in_progress",
  "already_proposed",
  "reply_subject_fixed",
  "check_sent_first",
  "already_replied",
  "reply_already_pending",
  "unavailable",
] as const;
export type ApprovalsErrorCode = (typeof APPROVALS_ERROR_CODES)[number];

/** Shown when the mailbox cannot send: the scope was not granted or the lane policy does not allow the type. */
export const NOT_ENABLED_MESSAGE = "Sending isn't enabled for this mailbox yet. Reconnect Google with send permission in Settings";
/** Shown when everything is enabled but the company is not yet switched on (T-170 gate). */
export const NOT_LIVE_MESSAGE = "Approvals are not live for this company yet.";

/** Another email in the same conversation is approved, being sent, or may already have gone out (T-234 part 3). */
export const CHECK_SENT_FIRST_MESSAGE = "An earlier reply to this conversation may already have gone out. Check your Sent folder first.";

const MESSAGES: Record<ApprovalsErrorCode, string> = {
  invalid: "The approval request is not valid.",
  forbidden: "You can't do that in this company.",
  step_up_required: "Enter a fresh authenticator code to approve.",
  not_found: "That approval no longer exists.",
  hash_mismatch: "This proposal changed since you opened it. Reload it and review the new version.",
  not_live: NOT_LIVE_MESSAGE,
  not_enabled: NOT_ENABLED_MESSAGE,
  already_approved: "This was already approved.",
  not_pending: "This is no longer waiting for approval.",
  expired: "This proposal expired. Ask for a new one.",
  not_editable: "This proposal can no longer be edited.",
  drafts_not_allowed: "This company does not store outbound drafts, so email proposals are off.",
  too_many_pending: "Too many proposals are waiting in this company. Clear some first.",
  sender_mismatch: "An email can only be sent from the connected mailbox.",
  in_progress: "This approval is already being carried out.",
  already_proposed: "A reply to this message is already waiting for approval.",
  reply_subject_fixed: "The subject of a reply can't be changed: it keeps the reply in its thread.",
  check_sent_first: CHECK_SENT_FIRST_MESSAGE,
  already_replied: "You already replied in this conversation after this draft was made. Edit and save it to send it anyway.",
  reply_already_pending: "A reply to this message is already waiting for approval. Open it to edit it.",
  unavailable: "Approvals are unavailable right now.",
};

export class ApprovalsError extends Error {
  override readonly name = "ApprovalsError";
  readonly code: ApprovalsErrorCode;
  constructor(code: ApprovalsErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

/** Maps a PostgREST error from the act.* functions (SQLSTATE and our fixed `act: <code>` messages). */
export function toApprovalsError(error: { code?: string | undefined; message?: string | undefined } | null | undefined): ApprovalsError {
  const message = error?.message ?? "";
  const code = error?.code;
  const has = (s: string) => message.includes(`act: ${s}`);
  if (has("step_up_required")) return new ApprovalsError("step_up_required");
  if (has("hash_mismatch")) return new ApprovalsError("hash_mismatch");
  if (has("not_live")) return new ApprovalsError("not_live");
  if (has("type_not_allowed") || has("connection_not_enabled")) return new ApprovalsError("not_enabled");
  if (has("already_approved")) return new ApprovalsError("already_approved");
  if (has("not_pending") || has("not_approved") || has("not_executing")) return new ApprovalsError("not_pending");
  if (has("already_claimed")) return new ApprovalsError("in_progress");
  if (has("expired")) return new ApprovalsError("expired");
  if (has("not_editable")) return new ApprovalsError("not_editable");
  if (has("not_found") || code === "P0002") return new ApprovalsError("not_found");
  if (message.includes("does not allow storing outbound drafts")) return new ApprovalsError("drafts_not_allowed");
  if (has("check_sent_first")) return new ApprovalsError("check_sent_first");
  if (has("already_replied")) return new ApprovalsError("already_replied");
  if (has("reply_already_pending")) return new ApprovalsError("reply_already_pending");
  if (has("already waiting for approval")) return new ApprovalsError("already_proposed");
  if (has("too many pending") || code === "54000") return new ApprovalsError("too_many_pending");
  if (code === "22023" || code === "22004" || code === "23514") return new ApprovalsError("invalid");
  if (code === "42501") return new ApprovalsError("forbidden");
  return new ApprovalsError("unavailable");
}
