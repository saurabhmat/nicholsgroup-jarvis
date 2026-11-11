// @nichols/approvals/server: the Approval Center for email (T-232). Server only. Import the wired dependencies from
// `./wire` (`approvalsDeps`); tests pass fakes. The public interface the briefing job (T-231d) uses is `proposeEmailAction`.
export { APPROVALS_ERROR_CODES, ApprovalsError, NOT_ENABLED_MESSAGE, NOT_LIVE_MESSAGE, toApprovalsError } from "./errors";
export type { ApprovalsErrorCode } from "./errors";
export { capabilityOf, emailWriteCapability } from "./capability";
export type { Capability, EmailWriteCapability } from "./capability";
export {
  approveAndExecute,
  editEmailProposal,
  executeApproved,
  listApprovals,
  pendingApprovalCount,
  proposeEmailAction,
  rejectAction,
} from "./email";
export type { ApproveResult, EmailChanges, EmailComposeInput, ProposeEmailInput, ProposeResult } from "./email";
export { hashOfRow } from "./rows";
export { EMAIL_ACTION_TYPES } from "./types";
export type { ActionRow, ActionStatus, ApprovalsDeps, CapabilityFacts, EmailActionType, ProposerKind, Rpc, UserCtx } from "./types";
