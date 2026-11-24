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

// T-262, T-263: the Microsoft email writer (Graph) and its reconciler read side. The write client itself is not exported: only the writer holds it.
export { microsoftEmailReconciler, microsoftEmailWriter } from "../microsoft/index";
export {
  DRAFT_CHANGED_MESSAGE,
  MICROSOFT_EMAIL_ACTIONS,
  MICROSOFT_WRITE_NOT_GRANTED_MESSAGE,
  NOT_IN_MAILBOX_MESSAGE,
  type MicrosoftEmailApprovedAction,
  type MicrosoftEmailReconciler,
  type MicrosoftEmailWriter,
} from "../microsoft/email-writer";
export { GRAPH_MAIL_WRITE_FEATURE } from "../microsoft/constants";

// T-255: what the approvals module's email dispatch (by the connection row's provider) needs. The dispatch itself lives in
// packages/modules/approvals; these are the read-only pieces: the lane's enabled-provider gate, the generic write-connection loader and
// the refusal test. A write or read-back for a connection whose provider is not enabled for the lane is refused before any token read.
export { createProviderGate, isProviderDisabledError } from "../facade/gate";
import { createProviderGate as makeProviderGate } from "../facade/gate";
import { ConnectorError } from "../contract/errors";
import { assertTeamsConnection } from "../teams/guard";
import { connectionLoader as writeConnectionLoader, laneConfigReader as writeLaneConfig } from "../vault/index";
export const emailWriteGate = makeProviderGate({ laneConfig: writeLaneConfig });
/** The authoritative, lane-bound connection row, whatever its provider (the dispatch refuses a provider that is not mail/calendar). */
export const loadEmailWriteConnection = (laneId: Parameters<typeof writeConnectionLoader.loadConnection>[0], connectionId: string) => writeConnectionLoader.loadConnection(laneId, connectionId);

// T-286, T-287: the Teams message writer (chat send, channel post, channel reply) and its reconciler read side. The write client itself is not exported: only the writer holds it.
// `loadTeamsWriteConnection` is the authoritative, lane-bound connection row and refuses a row that is not a Teams connection.
export { teamsMessageReconciler, teamsMessageWriter } from "../teams/writer-entry";
export {
  TEAMS_ACTION_TYPES,
  TEAMS_LOOKUP_SKEW_MS,
  TEAMS_LOOKUP_SPAN_MS,
  teamsLookupWindow,
  TEAMS_SEND_FAILURES,
  prepareTeamsWrite,
  teamsFailureCodeOf,
  type PreparedTeamsWrite,
  type TeamsApprovedAction,
  type TeamsLookupWindow,
  type TeamsMessageReconciler,
  type TeamsMessageWriter,
  type TeamsSendFailureCode,
} from "../teams/writer";
export {
  TEAMS_PAYLOAD_VERSION,
  TEAMS_POLICY_CLASS,
  TEAMS_SEND_FEATURE,
  TEAMS_TEXT_MAX_CHARS,
  isTeamsActionType,
  normalizeTeamsText,
  parseTeamsSend,
  teamsProposalContent,
  teamsTextProblem,
  type TeamsActionType,
  type TeamsProposalContent,
  type TeamsSend,
} from "../teams/send-schema";
export async function loadTeamsWriteConnection(laneId: Parameters<typeof writeConnectionLoader.loadConnection>[0], connectionId: string) {
  const conn = await writeConnectionLoader.loadConnection(laneId, connectionId);
  if (conn.provider !== "microsoft_teams") throw new ConnectorError({ kind: "not_found", message: "Connection not found" });
  assertTeamsConnection(conn);
  return conn;
}
