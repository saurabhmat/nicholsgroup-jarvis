// Shapes of the approvals module (T-232).
import type { LaneId } from "@nichols/core";
import type { Audit } from "@nichols/core/audit";
import type { ExecResult, LaneBoundConnection } from "@nichols/connectors";
import type { GoogleEmailApprovedAction, MicrosoftEmailApprovedAction, TeamsApprovedAction, TeamsLookupWindow } from "@nichols/connectors/write";

export const EMAIL_ACTION_TYPES = ["email.send", "email.save_draft"] as const;
export type EmailActionType = (typeof EMAIL_ACTION_TYPES)[number];
/** The QuickBooks disconnect (T-195, D-24): revoking our grant at Intuit is an external write, so it is an approvals action. */
export const QBO_DISCONNECT = "qbo.disconnect" as const;
export type QboActionType = typeof QBO_DISCONNECT;
/** A message in a Teams chat or channel (T-286, T-287; docs/specs/messages.md 10): an external write by the person who owns the Teams connection. */
export const TEAMS_ACTION_TYPES = ["teams.chat.send", "teams.channel.post", "teams.channel.reply"] as const;
export type TeamsActionType = (typeof TEAMS_ACTION_TYPES)[number];
export const ACTION_TYPES = [...EMAIL_ACTION_TYPES, QBO_DISCONNECT, ...TEAMS_ACTION_TYPES] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const isEmailType = (t: ActionType): t is EmailActionType => (EMAIL_ACTION_TYPES as readonly string[]).includes(t);
export const isTeamsType = (t: ActionType): t is TeamsActionType => (TEAMS_ACTION_TYPES as readonly string[]).includes(t);
/** The roles that may propose, approve and reject an action type (mirrors act.write_roles in the database). */
export const WRITE_ROLES: Readonly<Record<ActionType, readonly ["owner"] | readonly ["owner", "admin_technical"]>> = {
  // T-247: whoever owns the mailbox (the database also requires the connection to be the caller's own).
  "email.send": ["owner", "admin_technical"],
  "email.save_draft": ["owner", "admin_technical"],
  "qbo.disconnect": ["owner", "admin_technical"],
  // T-286 (D-68 default): whoever owns the Teams connection (the database also requires the connection to be the caller's own).
  "teams.chat.send": ["owner", "admin_technical"],
  "teams.channel.post": ["owner", "admin_technical"],
  "teams.channel.reply": ["owner", "admin_technical"],
};
export type ActionStatus = "proposed" | "approved" | "executing" | "verified" | "failed" | "rejected" | "expired" | "invalidated";
export type ProposerKind = "user" | "assistant" | "job";

/** An act.proposed_actions row as the app reads it. After a terminal state `payload.bodyText` is gone (D-19) and `payloadPurgedAt` is set. */
export type ActionRow = {
  id: string;
  laneId: string;
  actionType: ActionType;
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
  /** When the single claim was taken (the Teams lookup window starts a little before it). Absent from older callers' literals. */
  executingAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RpcResult = { data: unknown; error: { code?: string | undefined; message?: string | undefined } | null };
/** `client.schema("core").rpc` of a lane client: the user's (RLS) client or the lane's job (service role) client. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;

/** What the policy, the lane config and the connection say about sending from one mailbox. */
export type CapabilityFacts = {
  /** The connection's mailbox (its `external_account_id`), or null when the connection is not a usable Google or Microsoft connection of the lane. */
  mailbox: string | null;
  /** The connection's provider, when it is a usable email connection (T-263: the card and the messages name it). Absent: Google (older callers). */
  provider?: EmailProvider | null;
  /** `features.gmail_compose` (Google granted gmail.compose) or, for a Microsoft connection, `features.graph_mail_write` (Mail.ReadWrite and Mail.Send granted) on the last connect. */
  composeGranted: boolean;
  /** `core.lane_policies.write_actions_allowed` */
  writeActionsAllowed: readonly string[];
  /** `lane_config.approvals.approvals_live` (the T-170 gate). */
  approvalsLive: boolean;
  /** `lane_config.approvals.step_up_max_age_s` */
  stepUpMaxAgeS: number;
  /**
   * The connection as a QuickBooks connection of the lane that is not disconnected (T-195): its realm. Null (or absent) when it is
   * not a QuickBooks connection of the lane, or is disconnected.
   */
  qbo?: { realmId: string } | null;
  /**
   * The connection as a usable Teams connection of the lane (T-286): its owner, and whether the connection and the lane's `teams` block both allow chat sends and channel sends.
   * Null (or absent) when it is not a usable Teams connection of the lane.
   */
  teams?: { ownerUserId: string | null; chatSend: boolean; channelsSend: boolean } | null;
};

/** The email providers (T-262, T-263): the writer is picked by the action's connection row, never by the lane. */
export type EmailProvider = "google" | "microsoft";
export type EmailConn = LaneBoundConnection<EmailProvider>;
/** The approved action as either provider's writer takes it (the two shapes are the same). */
export type EmailApprovedAction = GoogleEmailApprovedAction | MicrosoftEmailApprovedAction;
/** What the executor and the reconciler hold: execute, read back and find, each by the connection's own provider (see ./email-dispatch.ts). */
export interface EmailWriteSurface {
  readonly actionTypes: readonly string[];
  executeWrite(laneId: LaneId, conn: EmailConn, action: EmailApprovedAction): Promise<ExecResult>;
  verifyWrite(laneId: LaneId, conn: EmailConn, action: EmailApprovedAction, externalId: string): Promise<void>;
  findWrite(laneId: LaneId, conn: EmailConn, action: EmailApprovedAction): Promise<string[]>;
  /** Provider-declared (by the connection's own provider): after an accepted send the sent copy may not be visible yet, so "not found" at read-back is not a failure (T-263). Absent = false (Google). */
  sentCopyMayLag?(conn: EmailConn): boolean;
}

export type ProposedEmail = { proposed: { target: Record<string, unknown>; payload: Record<string, unknown>; payload_schema_version: number }; connection: EmailConn };

/** Everything but the write path: what request code (pages, routes, the briefing) may hold (T-232 security review H1). */
export type ApprovalsPublicDeps = Omit<ApprovalsDeps, "writer" | "loadWriteConnection">;

export type ApprovalsDeps = {
  /** The lane's service-role client's `core` rpc (propose, claim, mark, expire). Wired to getLaneJobClient. */
  jobRpc(laneId: LaneId): Promise<Rpc>;
  /** Builds the proposed payload for an email action and loads the connection (no external effect). */
  prepareEmailWrite(laneId: LaneId, connectionId: string, intent: { action_type: EmailActionType; compose: Record<string, unknown> }): Promise<ProposedEmail>;
  /** The lane's own mail addresses, lower-cased (configured list plus connected accounts): for "never reply to ourselves". */
  laneMailboxes(laneId: LaneId): Promise<string[]>;
  /** T-247: whether this address may be a sender in the lane (allowed domain, and the exact list when the lane keeps one). */
  mailboxAllowed(laneId: LaneId, address: string): Promise<boolean>;
  readFacts(laneId: LaneId, connectionId: string): Promise<CapabilityFacts>;
  loadWriteConnection(laneId: LaneId, connectionId: string): Promise<EmailConn>;
  writer: EmailWriteSurface;
  audit: Audit;
};

/** The signed-in user acting in one lane. `rpc` is the user's own (RLS) client, from requireLane; the route has already checked the role and step-up. */
export type UserCtx = { laneId: LaneId; userId: string; rpc: Rpc };

/** The approvals-only Teams writer as the executor and the reconciler hold it (T-286, T-287): execute once, read back, and look up. The reconciler is handed `findWrite` and `verifyWrite` only. */
export type TeamsConn = LaneBoundConnection<"microsoft_teams">;
export interface TeamsWriteSurface {
  readonly actionTypes: readonly string[];
  executeWrite(laneId: LaneId, conn: TeamsConn, action: TeamsApprovedAction): Promise<ExecResult>;
  verifyWrite(laneId: LaneId, conn: TeamsConn, action: TeamsApprovedAction, externalId: string, window?: TeamsLookupWindow): Promise<void>;
  findWrite(laneId: LaneId, conn: TeamsConn, action: TeamsApprovedAction, window?: TeamsLookupWindow): Promise<string[]>;
}
