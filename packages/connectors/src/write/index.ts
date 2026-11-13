// `@nichols/connectors/write`: the write-side wiring of each connector, for the approvals module only (rule 5, decided
// D-24: even revoking our own QuickBooks grant at Intuit is an external write). The branded action and the lint that
// restricts this import to packages/modules/approvals arrive with T-193 / the approvals tasks; a test fails meanwhile
// if any other production file imports this subpath or the QuickBooks writer.
export { quickbooksWriter, quickbooksDisconnectVerifier, loadQuickbooksWriteConnection } from "../quickbooks/index";
export { QBO_REVOKE_ACTION, QBO_REVOKED_NOT_RECORDED_MESSAGE, QBO_VERIFICATION_MISMATCH_MESSAGE, type QboApprovedAction } from "../quickbooks/writer";
export { googleWriter } from "../google/index";
export { GOOGLE_REVOKE_ACTION, type GoogleApprovedAction } from "../google/writer";
export { googleEmailReconciler, googleEmailWriter, loadGoogleWriteConnection } from "../google/index";
export {
  GMAIL_COMPOSE_FEATURE,
  GOOGLE_EMAIL_ACTIONS,
  OUTCOME_UNKNOWN_MESSAGE,
  VERIFICATION_MISMATCH_MESSAGE,
  type GoogleEmailApprovedAction,
  type GoogleEmailReconciler,
  type GoogleEmailWriter,
} from "../google/email-writer";
