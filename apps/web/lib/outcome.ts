// Which failure codes mean "the email MAY have gone out" (T-192, T-232). Pure and client-safe: the Approvals card and the
// Reply drawer both use it. A verification mismatch means a message with our Message-ID exists, so the owner must check
// the Sent folder (or Drafts) before asking for it again. The reconciler's codes all start with `reconcile_`.
const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set(["outcome_unknown", "verification_unavailable", "verification_mismatch", "marker_not_found", "ambiguous_match"]);

export function isOutcomeUnknown(code: string | null | undefined): boolean {
  return typeof code === "string" && (OUTCOME_UNKNOWN_CODES.has(code) || code.startsWith("reconcile_"));
}
