import "server-only";
// @nichols/approvals/server: the Approval Center for email (T-232). Server only. Import the wired dependencies from
// `./wire` (`approvalsDeps`); tests pass fakes. The public interface the briefing job (T-231d) uses is `proposeEmailAction`.
export { APPROVALS_ERROR_CODES, ApprovalsError, CHECK_SENT_FIRST_MESSAGE, NOT_ENABLED_MESSAGE, NOT_LIVE_MESSAGE, toApprovalsError } from "./errors";
export type { ApprovalsErrorCode } from "./errors";
export { capabilityOf, emailWriteCapability } from "./capability";
export type { Capability, EmailWriteCapability } from "./capability";
// approveAndExecute / executeApproved need the write path: request code uses approveAndExecuteEmail from
// `@nichols/approvals/wire`, which keeps the writer private (T-232 security review H1).
export {
  editEmailProposal,
  getApproval,
  listApprovals,
  pendingApprovalCount,
  proposeEmailAction,
  rejectAction,
} from "./email";
export type { ApproveResult, EmailChanges, EmailComposeInput, ProposeEmailInput, ProposeResult } from "./email";
export { hashOfRow } from "./rows";
export { EMAIL_ACTION_TYPES } from "./types";
export type { ActionRow, ActionStatus, ApprovalsDeps, ApprovalsPublicDeps, CapabilityFacts, EmailActionType, ProposerKind, Rpc, UserCtx } from "./types";
// action.reconcile_stuck (T-192); the wired sweep is `reconcileStuckLane` in `@nichols/approvals/wire`.
export { RECONCILE_BATCH, reconcileStuckActions } from "./reconcile";
export type { ActionReconciler, ReconcileDecision, ReconcileDeps, ReconcileInput, ReconcileSummary } from "./reconcile";
