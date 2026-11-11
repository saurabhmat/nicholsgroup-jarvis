// Shapes of the approvals module (T-232).
import type { LaneId } from "@nichols/core";
import type { Audit } from "@nichols/core/audit";
import type { LaneBoundConnection } from "@nichols/connectors";
import type { GoogleEmailWriter } from "@nichols/connectors/write";

export const EMAIL_ACTION_TYPES = ["email.send", "email.save_draft"] as const;
export type EmailActionType = (typeof EMAIL_ACTION_TYPES)[number];
export type ActionStatus = "proposed" | "approved" | "executing" | "verified" | "failed" | "rejected" | "expired" | "invalidated";
export type ProposerKind = "user" | "assistant" | "job";

/** An act.proposed_actions row as the app reads it. After a terminal state `payload.bodyText` is gone (D-19) and `payloadPurgedAt` is set. */
export type ActionRow = {
  id: string;
  laneId: string;
  actionType: EmailActionType;
  connectionId: string;
  provider: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadSchemaVersion: number;
  payloadSha256: string;
  rationale: string | null;
  sourceRefs: unknown[];
  proposerKind: ProposerKind;
  proposerUserId: string | null;
  derivedFromRetrieved: boolean;
  supersedesId: string | null;
  supersededById: string | null;
  status: ActionStatus;
  expiresAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedHash: string | null;
  executedAt: string | null;
  verifiedAt: string | null;
  result: Record<string, unknown>;
  failureCode: string | null;
  payloadPurgedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RpcResult = { data: unknown; error: { code?: string | undefined; message?: string | undefined } | null };
/** `client.schema("core").rpc` of a lane client: the user's (RLS) client or the lane's job (service role) client. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

/** What the policy, the lane config and the connection say about sending from one mailbox. */
export type CapabilityFacts = {
  /** The connection's mailbox (its `external_account_id`), or null when the connection is not a usable Google connection of the lane. */
  mailbox: string | null;
  /** `features.gmail_compose`: Google granted gmail.compose on the last connect. */
  composeGranted: boolean;
  /** `core.lane_policies.write_actions_allowed` */
  writeActionsAllowed: readonly string[];
  /** `lane_config.approvals.approvals_live` (the T-170 gate). */
  approvalsLive: boolean;
  /** `lane_config.approvals.step_up_max_age_s` */
  stepUpMaxAgeS: number;
};

export type ProposedEmail = { proposed: { target: Record<string, unknown>; payload: Record<string, unknown>; payload_schema_version: number }; connection: LaneBoundConnection<"google"> };

/** Everything but the write path: what request code (pages, routes, the briefing) may hold (T-232 security review H1). */
export type ApprovalsPublicDeps = Omit<ApprovalsDeps, "writer" | "loadWriteConnection">;

export type ApprovalsDeps = {
  /** The lane's service-role client's `core` rpc (propose, claim, mark, expire). Wired to getLaneJobClient. */
  jobRpc(laneId: LaneId): Promise<Rpc>;
  /** Builds the proposed payload for an email action and loads the connection (no external effect). */
  prepareEmailWrite(laneId: LaneId, connectionId: string, intent: { action_type: EmailActionType; compose: Record<string, unknown> }): Promise<ProposedEmail>;
  /** `lane_config.mailboxes` of the lane, lower-cased. */
  laneMailboxes(laneId: LaneId): Promise<string[]>;
  readFacts(laneId: LaneId, connectionId: string): Promise<CapabilityFacts>;
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<"google">>;
  writer: GoogleEmailWriter;
  audit: Audit;
};

/** The signed-in user acting in one lane. `rpc` is the user's own (RLS) client, from requireLane; the route has already checked the role and step-up. */
export type UserCtx = { laneId: LaneId; userId: string; rpc: Rpc };
