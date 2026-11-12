// Fixed texts of the Reply drawer (T-234 part 3). Client-safe (no server imports): the server refuses with these codes and
// texts, and the drawer shows the same strings. Never row text, provider text or a prompt.
export const REPLY_ERROR_CODES = ["not_replyable", "ai_not_allowed", "ai_not_configured", "ai_failed", "rate_limited", "body_unavailable", "check_sent_first"] as const;
export type ReplyErrorCode = (typeof REPLY_ERROR_CODES)[number];

export const REPLY_MESSAGES: Record<ReplyErrorCode, string> = {
  not_replyable: "This message cannot be replied to from here. Open it in Jarvis instead.",
  ai_not_allowed: "AI drafting of replies is not enabled for this company. Write the reply yourself.",
  ai_not_configured: "AI drafting is not set up yet. Write the reply yourself.",
  ai_failed: "The AI could not draft a reply right now. Write it yourself or try again in a minute.",
  rate_limited: "A draft was just made for this thread. Wait a minute before asking for another.",
  body_unavailable: "The message could not be read right now, so no draft was made.",
  check_sent_first: "An earlier send of a reply to this message may have gone out. Check the Sent folder before replying again.",
};

/** Shown instead of Save draft and Send when the lane does not store outbound drafts (D-19). Copy still works. */
export const DRAFTS_OFF_MESSAGE = "This company does not store outbound drafts, so replies cannot be saved or sent from here. Copy still works.";

export const UNKNOWN_MESSAGE = "Sending status unknown: check Sent before retrying.";

export type ReplyOutcome = "sent" | "failed" | "unknown";

const FAILED: Record<string, string> = {
  connection_unhealthy: "The email was not sent: Google needs to be reconnected. Reconnect in Settings, then try again.",
  execution_refused: "The email was not sent: Google refused it. Check the recipients and try again.",
  execution_error: "The email was not sent because of an error. You can try again.",
  payload_changed: "The reply changed after you approved it, so it was not sent. Review it and send it again.",
};

/**
 * What to tell the owner after approve. A verification problem (the email may exist in the mailbox) is never plain "failed":
 * "Check your Sent folder before trying again" (T-232 L5, T-192). Unknown and in-progress never offer a blind second send.
 */
export function resultMessage(outcome: ReplyOutcome, failureCode: string | null): string {
  if (outcome === "sent") return "Sent. The reply was checked in the mailbox.";
  if (outcome === "unknown") {
    return failureCode !== null && (failureCode.startsWith("verification_") || failureCode === "marker_not_found" || failureCode === "ambiguous_match")
      ? "The email may have been sent but could not be confirmed. Check your Sent folder before trying again."
      : UNKNOWN_MESSAGE;
  }
  return (failureCode !== null ? FAILED[failureCode] : undefined) ?? "The email was not sent. You can review the reply and try again.";
}
