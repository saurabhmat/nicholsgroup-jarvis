// The approvals-only Microsoft Teams message writer (T-287; docs/specs/messages.md 10.4): `teams.chat.send`, `teams.channel.post`, `teams.channel.reply`. A `ConnectorWriter` that only the approvals
// module may execute (rule 5: proposal -> the connection's owner approves the exact payload -> execute once -> verify -> audit). It is built only in ./writer-entry.ts and exported only through
// the connectors write subpath; nothing here is reachable from a route, page, job or tool.
//
// Before any request, in this order (`prepareTeamsWrite`): lane and connection brand, provider, the action's lane, connection and type, the approver and action ids, the payload hash
// (constant time), the target and payload schemas (plain text only), then the Teams guard (authoritative row: status, Teams enabled for the lane, tenant, cloud, domain, the send feature on the
// lane AND on the connection, and the row's OWNER = the approver: no token read), and, for `executeWrite` only, the approvals database's open execution claim.
//
// ONE POST. A message post is not idempotent at Microsoft (no dedupe header; a repeat after a timeout can post twice, vendor facts A2), so `executeWrite` sends exactly one POST with `retry: false`
// (the write client adds no transport retry; its one extra attempt after a 401 is a request Microsoft did not process). The approvals database's single execution claim is the guard against a
// second `executeWrite` of the same action; this module adds its own: an action id this process already posted is refused. After a timeout, a network error or a 5xx the outcome is UNKNOWN and
// the message is NEVER posted again: it is looked up by a date range (the person's own message, the same normalised text, created after the claim). One match = it was posted (`already_applied`),
// two or more = `ambiguous_match`, none = the action stays `executing` for the reconcile sweep (`outcome_pending`). 400, 403, 404, 413 and 429 are definite (nothing was sent), with fixed messages.
//
// Read-back (`verifyWrite`): the message is read by its id and must be the person's own (the sender's Entra object id), in the same chat or channel (and reply parent), created after the claim,
// with the same text once both are converted to plain text and normalised. The body form Teams returns for a text post is not stated in the fact sheet, so `text` and `html` are both handled; the
// FORM (never the text) is logged as `teams.send.read_back_form`. A message text is never logged, put in an error, or returned.
//
// Honest limits: a chat message has no property the portal can set, so the lookup can take a message with the same text that the person typed in Teams in the same window as ours (accepted, spec
// section 10.4); a channel post or reply is read back from the newest 50 root posts or replies (no single-message read route is allow-listed), so in a very busy thread it may not be found and
// stays for the sweep.
import { timingSafeEqual } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { ExecResult } from "../contract/schemas";
import { computePayloadSha256, type ApprovedActionShape, type ConnectorWriter } from "../contract/writer";
import { connectorLog, type ConnectorLogger } from "../log/index";
import type { ActionClaimReader } from "../vault/write-policy";
import type { TeamsApi } from "./api";
import { TEAMS_PROVIDER, TEAMS_WRITE_ROUTES } from "./constants";
import { assertTeamsConnection, type GuardedTeamsConnection, type TeamsGuard } from "./guard";
import { bodyToNodes, nodesToPlainText } from "./message-html";
import { normalizeTime } from "./reader";
import { isTeamsActionType, parseTeamsSend, TEAMS_ACTION_TYPES, TEAMS_SEND_FEATURE, type TeamsSend } from "./send-schema";
import type { TeamsWriteClient } from "./write-client";

export { TEAMS_ACTION_TYPES };

/** The failure codes of a Teams send (`act.proposed_actions.failure_code`) and the one fixed sentence of each. The page shows these; none contains message text. */
export const TEAMS_SEND_FAILURES = Object.freeze({
  send_rejected: "Teams did not accept this message, so nothing was sent",
  not_a_member: "You are not a member of this chat or channel, or sending is not allowed",
  target_not_found: "This chat or channel was not found, so nothing was sent",
  message_too_large: "This message is too large for Teams, so nothing was sent",
  throttled: "Teams is busy, so nothing was sent. Press Send again in a moment",
  connection_unhealthy: "Your Teams sign-in needs to be renewed, so nothing was sent. Reconnect Teams",
  execution_refused: "This message could not be sent, so nothing was sent",
  verification_mismatch: "Sent, but Teams shows different text; check the chat",
  ambiguous_match: "More than one matching message was found in Teams; check the chat",
  outcome_unknown: "Outcome unknown: check the chat in Teams before sending again",
  /** The disconnect purge of an executing action (a code every layer treats as an unknown outcome: `reconcile_` prefix). */
  reconcile_connection_disconnected: "The connection was disconnected while this message was being sent; it may have been delivered. Check the chat in Teams before sending again",
  /** Not a final state: the lookup found nothing yet, so the action stays `executing` and the sweep looks again. */
  outcome_pending: "The message may not have reached Teams yet; it is being checked",
  /** The read-back could not run (the message was accepted): stays `executing` for the sweep. */
  verification_unavailable: "The message was sent, but Teams could not be asked about it yet",
} as const);
export type TeamsSendFailureCode = keyof typeof TEAMS_SEND_FAILURES;
const MESSAGE_TO_CODE: ReadonlyMap<string, TeamsSendFailureCode> = new Map((Object.entries(TEAMS_SEND_FAILURES) as [TeamsSendFailureCode, string][]).map(([c, m]) => [m, c]));
/** The failure code of an error this writer threw (by its fixed message), or null for any other error. */
export function teamsFailureCodeOf(e: unknown): TeamsSendFailureCode | null {
  return isConnectorError(e) ? (MESSAGE_TO_CODE.get(e.info.message) ?? null) : null;
}
const KIND_OF_CODE: Record<TeamsSendFailureCode, "invalid_input" | "forbidden" | "not_found" | "rate_limited" | "reconnect_required" | "provider_error" | "timeout"> = {
  send_rejected: "invalid_input",
  not_a_member: "forbidden",
  target_not_found: "not_found",
  message_too_large: "invalid_input",
  throttled: "rate_limited",
  connection_unhealthy: "reconnect_required",
  execution_refused: "forbidden",
  verification_mismatch: "provider_error",
  ambiguous_match: "provider_error",
  outcome_unknown: "provider_error",
  outcome_pending: "timeout",
  verification_unavailable: "timeout",
  reconcile_connection_disconnected: "provider_error",
};
const fail = (code: TeamsSendFailureCode) => new ConnectorError({ kind: KIND_OF_CODE[code], message: TEAMS_SEND_FAILURES[code] });
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** The approver is carried explicitly, as for email. */
export type TeamsApprovedAction = ApprovedActionShape & { readonly approved_by: string };

/** Where to look: messages created at or after `since` (an ISO instant; the claim time minus the skew allowance). Absent: no lower bound on the read-back, and the last 24 hours for a lookup. */
export type TeamsLookupWindow = { since?: string | undefined };

export type TeamsMessageWriterDeps = {
  /** The Teams guard (authoritative row, Teams enabled, tenant, cloud, domain, feature, owner). Reads no token. */
  guard: TeamsGuard;
  /** GET-only guarded client: the read-back and the lookup. */
  api: TeamsApi;
  /** The allow-listed POST client. */
  write: TeamsWriteClient;
  /** The approvals database's check that this action is executing with an open claim. */
  claims: Pick<ActionClaimReader, "claimOpen">;
  /** Which of these message ids another action of the connection already recorded as its own (ids only): the lookup never takes an earlier send as this one. */
  claimed: { claimedExternalIds(laneId: LaneId, connectionId: string, exceptActionId: string, ids: readonly string[]): Promise<string[]> };
  logger?: ConnectorLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Pause before the lookup that follows an unknown outcome (Microsoft limits a chat to 1 read per second). Default 1000. */
  lookupPauseMs?: number;
};

export interface TeamsMessageWriter extends ConnectorWriter<TeamsApprovedAction, typeof TEAMS_PROVIDER> {
  /**
   * Reads the message back by its id (the one POST returned, or one the lookup found) and compares sender, place, time and text. Throws the `verification_mismatch` sentence on a difference, a
   * `not_found` ConnectorError when the message is not (yet) there, and whatever the read raised otherwise.
   */
  verifyWrite(laneId: LaneId, conn: LaneBoundConnection<typeof TEAMS_PROVIDER>, action: TeamsApprovedAction, externalId: string, window?: TeamsLookupWindow): Promise<void>;
  /** Read-only lookup for recovery: the ids of the person's own matching messages since `window.since` (at most 5). Writes nothing. */
  findWrite(laneId: LaneId, conn: LaneBoundConnection<typeof TEAMS_PROVIDER>, action: TeamsApprovedAction, window?: TeamsLookupWindow): Promise<string[]>;
}

/** What the reconciler may hold: look up and read back, never `executeWrite`. */
export type TeamsMessageReconciler = Pick<TeamsMessageWriter, "findWrite" | "verifyWrite">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Messages are looked for from this long before the POST started (Microsoft's clock and ours may differ). Small on purpose: a wide window would take an EARLIER message with the same text
 * (the previous send, or one typed in Teams) as this one. The reconciler uses the same bound from the time the claim was taken (which precedes the POST by milliseconds).
 */
export const TEAMS_LOOKUP_SKEW_MS = 15_000;
/** The lookup and read-back window of an action claimed at `executingAt` (an ISO instant): from a little before it. Empty when the time is unknown. One definition for the executor and the sweep. */
export function teamsLookupWindow(executingAt: string | null | undefined): TeamsLookupWindow {
  const ms = executingAt ? Date.parse(executingAt) : Number.NaN;
  return Number.isNaN(ms) ? {} : { since: new Date(ms - TEAMS_LOOKUP_SKEW_MS).toISOString() };
}
const LOOKUP_PAGE = 50;
const LOOKUP_DEFAULT_MS = 24 * 3600_000;
const MAX_FOUND = 5;
const PLAIN_MAX = 40_000;
const LOOKUP_TIMEOUT_MS = 15_000;

function assertPayloadHash(action: TeamsApprovedAction): void {
  let expected: string;
  try {
    expected = computePayloadSha256(action);
  } catch {
    throw refused("The approved action cannot be verified");
  }
  const given = action.payload_sha256;
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given) || !timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"))) {
    throw refused("The approved action does not match its approval");
  }
}

export type PreparedTeamsWrite = {
  /** What the guard approved for this call (authoritative row, the account's Entra object id). */
  readonly g: GuardedTeamsConnection;
  readonly send: TeamsSend;
  readonly approvedBy: string;
};

/**
 * Every check that must pass before Teams is asked anything or told anything. Throws a ConnectorError and sends nothing. Reads no token.
 * The lane, the connection, the type, the hash, the schemas and the guard (feature on the lane and the connection, owner = approver).
 */
export async function prepareTeamsWrite(deps: Pick<TeamsMessageWriterDeps, "guard">, laneId: LaneId, conn: LaneBoundConnection<typeof TEAMS_PROVIDER>, action: TeamsApprovedAction): Promise<PreparedTeamsWrite> {
  assertLaneBound(laneId, conn);
  assertTeamsConnection(conn);
  if (typeof action !== "object" || action === null) throw refused("The approved action is not valid");
  if (action.lane_id !== laneId || action.connection_id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "The approved action is for another lane or connection" });
  if (!isTeamsActionType(action.action_type)) throw new ConnectorError({ kind: "unsupported_op", message: "Unsupported Teams action" });
  if (typeof action.approved_by !== "string" || !UUID.test(action.approved_by)) throw refused("The approving user is required");
  if (typeof action.id !== "string" || !UUID.test(action.id)) throw refused("The action id is not valid");
  assertPayloadHash(action);
  const send = parseTeamsSend(action.action_type, action.target, action.payload);
  if (send === null) throw refused("The approved message is not valid");
  const approvedBy = action.approved_by.toLowerCase();
  // The guard runs with the feature the type needs and with the approver as the row's required owner: only the connection's owner sends from it (an admin cannot, whatever the approvals
  // database recorded).
  const g = await deps.guard(laneId, conn, { feature: TEAMS_SEND_FEATURE[send.type], actorUserId: approvedBy });
  if (g.conn.id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection row does not match" });
  return { g, send, approvedBy };
}

// ---- reading messages back
const MessageSchema = z.looseObject({
  id: z.string().min(1).max(512),
  messageType: z.string().max(64).nullish(),
  createdDateTime: z.string().max(64).nullish(),
  deletedDateTime: z.string().max(64).nullish(),
  chatId: z.string().max(512).nullish(),
  replyToId: z.string().max(512).nullish(),
  channelIdentity: z.looseObject({ teamId: z.string().max(128).nullish(), channelId: z.string().max(512).nullish() }).nullish(),
  from: z.looseObject({ user: z.looseObject({ id: z.string().max(64).nullish() }).nullish() }).nullish(),
  body: z.looseObject({ contentType: z.string().max(32).nullish(), content: z.string().nullish() }).nullish(),
});
type GraphMessage = z.infer<typeof MessageSchema>;
const ListSchema = z.looseObject({ value: z.array(z.unknown()).max(500) });

const parseMessage = (data: unknown): GraphMessage => {
  const p = MessageSchema.safeParse(data);
  if (!p.success) throw new ConnectorError({ kind: "provider_error", message: "Teams message is not valid" });
  return p.data;
};
const parseList = (data: unknown): GraphMessage[] => {
  const l = ListSchema.safeParse(data);
  if (!l.success) throw new ConnectorError({ kind: "provider_error", message: "Teams message list is not valid" });
  const out: GraphMessage[] = [];
  for (const raw of l.data.value) {
    const m = MessageSchema.safeParse(raw);
    if (m.success) out.push(m.data);
  }
  return out;
};

/** Plain text, whitespace collapsed, NFC: the same view of what was approved and of what Teams shows. */
const plain = (contentType: string | null | undefined, content: string | null | undefined): string => nodesToPlainText(bodyToNodes(contentType, content).nodes, PLAIN_MAX).normalize("NFC");

export function createTeamsMessageWriter(deps: TeamsMessageWriterDeps): TeamsMessageWriter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = () => (deps.now ?? Date.now)();
  const baseLog = deps.logger ?? connectorLog;
  /** A structured line with the lane, connection and ids only: never message text. */
  const logFor = (laneId: LaneId, connectionId: string) => baseLog.child({ laneId, provider: TEAMS_PROVIDER, connectionId });
  /** Action ids this process has already sent to Teams (at most one POST per action here, whatever else is true). Bounded. */
  const attempted = new Set<string>();

  /** The read request for the messages of the place a send went to. Chats: the documented date range. Channels: the newest 50 (no date filter is documented for them). */
  async function listPlace(laneId: LaneId, p: PreparedTeamsWrite, sinceIso: string): Promise<GraphMessage[]> {
    const actor = { kind: "user" as const, userId: p.approvedBy };
    const common = { actor, retry: false, timeoutMs: LOOKUP_TIMEOUT_MS };
    const s = p.send;
    if (s.type === "teams.chat.send") {
      const res = await deps.api.get(laneId, p.g.conn, { ...common, path: "/chats/{chatId}/messages", params: { chatId: s.chatId }, query: { $top: LOOKUP_PAGE, $orderby: "lastModifiedDateTime desc", $filter: `lastModifiedDateTime gt ${sinceIso}` } });
      return parseList(res.data);
    }
    if (s.type === "teams.channel.post") {
      const res = await deps.api.get(laneId, p.g.conn, { ...common, path: "/teams/{teamId}/channels/{channelId}/messages", params: { teamId: s.teamId, channelId: s.channelId }, query: { $top: LOOKUP_PAGE } });
      return parseList(res.data);
    }
    const res = await deps.api.get(laneId, p.g.conn, { ...common, path: "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies", params: { teamId: s.teamId, channelId: s.channelId, messageId: s.replyToId }, query: { $top: LOOKUP_PAGE } });
    return parseList(res.data);
  }

  /** Everything about a message except its text and time: the person's own, a message (not a system event), not deleted, in the right place, and the right kind (root post / reply). */
  function isOwnInPlace(m: GraphMessage, p: PreparedTeamsWrite): boolean {
    if (m.messageType != null && m.messageType !== "message") return false;
    if (m.deletedDateTime != null) return false;
    if ((m.from?.user?.id ?? "").toLowerCase() !== p.g.entraObjectId.toLowerCase()) return false;
    const s = p.send;
    if (s.type === "teams.chat.send") return m.chatId == null || m.chatId === s.chatId;
    const ci = m.channelIdentity;
    if (ci != null && ((ci.teamId != null && ci.teamId.toLowerCase() !== s.teamId) || (ci.channelId != null && ci.channelId !== s.channelId))) return false;
    if (s.type === "teams.channel.post") return m.replyToId == null || m.replyToId === "";
    return m.replyToId == null || m.replyToId === s.replyToId;
  }
  const createdMs = (m: GraphMessage): number | null => {
    const t = normalizeTime(m.createdDateTime);
    return t === null ? null : Date.parse(t);
  };
  const sameText = (m: GraphMessage, p: PreparedTeamsWrite): boolean => plain(m.body?.contentType, m.body?.content) === plain("text", p.send.text);
  const sinceOf = (window: TeamsLookupWindow | undefined, fallbackMs: number): { iso: string; ms: number } => {
    const parsed = window?.since !== undefined ? normalizeTime(window.since) : null;
    const ms = parsed !== null ? Date.parse(parsed) : fallbackMs;
    return { iso: new Date(ms).toISOString(), ms };
  };

  /** The ids of the person's own messages in the place since `since` whose text equals the approved text, minus any message another action of this connection already recorded as its own. */
  async function lookup(laneId: LaneId, p: PreparedTeamsWrite, actionId: string, since: { iso: string; ms: number }): Promise<string[]> {
    const ids: string[] = [];
    for (const m of await listPlace(laneId, p, since.iso)) {
      const created = createdMs(m);
      if (created === null || created < since.ms) continue;
      if (isOwnInPlace(m, p) && sameText(m, p)) ids.push(m.id);
      if (ids.length >= MAX_FOUND) break;
    }
    if (ids.length === 0) return ids;
    const taken = new Set(await deps.claimed.claimedExternalIds(laneId, p.g.conn.id, actionId, ids));
    return ids.filter((id) => !taken.has(id));
  }

  /** The failure code when the POST certainly did not create a message, else null (its outcome is unknown). Decided by the HTTP status, never by a message text. */
  function definiteCode(e: unknown): TeamsSendFailureCode | null {
    if (!isConnectorError(e)) return null;
    const i = e.info;
    const s = i.http_status;
    if (s === 429 || i.kind === "rate_limited") return "throttled";
    if (typeof s === "number") {
      if (s === 400) return "send_rejected"; // only these six statuses are definite
      if (s === 401) return "connection_unhealthy"; // after the client's one refresh: Microsoft did not process it
      if (s === 403) return "not_a_member";
      if (s === 404) return "target_not_found";
      if (s === 413) return "message_too_large";
      return null; // 408, 409, 423, any other status, a 5xx, a redirect or an odd 2xx: the outcome is unknown, so it is looked up (never posted again)
    }
    // No HTTP status: refused before a request left (a guard or template refusal), or a transport failure.
    if (i.kind === "reconnect_required" || i.kind === "connection_unavailable") return "connection_unhealthy";
    if (i.kind === "invalid_input" || i.kind === "forbidden" || i.kind === "lane_mismatch" || i.kind === "unsupported_op" || i.kind === "not_found") return "execution_refused";
    return null; // timeout, transient, provider_error, anything else: it may have been processed
  }

  const executeWrite: TeamsMessageWriter["executeWrite"] = async (laneId, conn, action) => {
    // Everything before the POST is "nothing was sent": a refusal keeps its kind; an infrastructure failure (a database read of the guard) is reported as not sent too, never as an unknown outcome.
    const p = await prepareTeamsWrite(deps, laneId, conn, action).catch((e: unknown) => {
      throw isConnectorError(e) && definiteCode(e) !== null ? e : fail("execution_refused");
    });
    // Defence in depth: whoever holds this writer, nothing is posted unless the approvals database has this exact action approved (same hash, same approver) and claimed with nothing sent yet.
    if (!(await deps.claims.claimOpen(laneId, action.id, action.payload_sha256, action.approved_by))) {
      throw new ConnectorError({ kind: "forbidden", message: "This action is not approved and claimed for execution" });
    }
    // At most one POST per action in this process, whatever the claim says (a faulty caller that executes twice is refused here).
    // (Whether the earlier attempt delivered is not known here, so this is an unknown-outcome answer, never "nothing was sent".)
    if (attempted.has(action.id)) throw fail("outcome_pending");
    attempted.add(action.id);
    if (attempted.size > 5000) attempted.delete(attempted.values().next().value as string);

    const started = nowMs();
    const executedAt = () => new Date(nowMs()).toISOString();
    const s = p.send;
    const path = s.type === "teams.chat.send" ? "/chats/{chatId}/messages" : s.type === "teams.channel.post" ? "/teams/{teamId}/channels/{channelId}/messages" : "/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies";
    if (!Object.hasOwn(TEAMS_WRITE_ROUTES, path)) throw refused("This Teams write is not allowed");
    const params: Record<string, string> =
      s.type === "teams.chat.send" ? { chatId: s.chatId } : s.type === "teams.channel.post" ? { teamId: s.teamId, channelId: s.channelId } : { teamId: s.teamId, channelId: s.channelId, messageId: s.replyToId };

    const unknownOutcome = async (): Promise<ExecResult> => {
      // The message may or may not exist: look for it (never post again).
      await sleep(deps.lookupPauseMs ?? 1000);
      let ids: string[];
      try {
        const from = started - TEAMS_LOOKUP_SKEW_MS;
        ids = await lookup(laneId, p, action.id, { iso: new Date(from).toISOString(), ms: from });
      } catch {
        throw fail("outcome_pending"); // the lookup itself failed: the action stays executing and the sweep looks again
      }
      if (ids.length === 1) return { outcome: "already_applied", external_id: ids[0] as string, executed_at: executedAt(), provider_tid: null };
      if (ids.length > 1) throw fail("ambiguous_match");
      throw fail("outcome_pending");
    };

    let res: Awaited<ReturnType<TeamsWriteClient["post"]>>;
    try {
      res = await deps.write.post(laneId, p.g.conn, { path, params, actorUserId: p.approvedBy, body: { body: { contentType: "text", content: s.text } } });
    } catch (e) {
      const code = definiteCode(e);
      if (code !== null) throw fail(code);
      return unknownOutcome();
    }
    const data = res.data as { id?: unknown } | null;
    const id = typeof data?.id === "string" && /^[A-Za-z0-9._:=@-]{1,256}$/.test(data.id) ? data.id : null;
    if (res.status !== 201 || id === null) return unknownOutcome(); // accepted in some way we cannot read: look, never post again
    return { outcome: "accepted", external_id: id, executed_at: executedAt(), provider_tid: res.providerTid };
  };

  return {
    provider: TEAMS_PROVIDER,
    actionTypes: TEAMS_ACTION_TYPES,
    executeWrite,
    async findWrite(laneId, conn, action, window) {
      const p = await prepareTeamsWrite(deps, laneId, conn, action);
      return lookup(laneId, p, action.id, sinceOf(window, nowMs() - LOOKUP_DEFAULT_MS));
    },
    async verifyWrite(laneId, conn, action, externalId, window) {
      const p = await prepareTeamsWrite(deps, laneId, conn, action);
      if (typeof externalId !== "string" || !/^[A-Za-z0-9._:=@-]{1,256}$/.test(externalId)) throw refused("The message id is not valid");
      const mismatch = () => fail("verification_mismatch");
      const notFound = () => new ConnectorError({ kind: "not_found", message: "The message was not found in Teams" });
      const actor = { kind: "user" as const, userId: p.approvedBy };
      const s = p.send;
      let m: GraphMessage | undefined;
      if (s.type === "teams.chat.send") {
        m = parseMessage((await deps.api.get(laneId, p.g.conn, { path: "/chats/{chatId}/messages/{messageId}", params: { chatId: s.chatId, messageId: externalId }, actor, retry: false, timeoutMs: LOOKUP_TIMEOUT_MS })).data);
      } else {
        // No single-message read route is allow-listed for channels: the newest posts (or replies) are listed and the id is picked out.
        m = (await listPlace(laneId, p, new Date(0).toISOString())).find((x) => x.id === externalId);
      }
      if (m === undefined) throw notFound();
      if (m.id !== externalId) throw mismatch();
      if (!isOwnInPlace(m, p)) throw mismatch();
      // Created after the claim (with the skew allowance), by Microsoft's clock.
      if (window?.since !== undefined) {
        const created = createdMs(m);
        const since = sinceOf(window, 0);
        if (created === null || created < since.ms) throw mismatch();
      }
      const form = m.body?.contentType === "text" || m.body?.contentType === "html" ? m.body.contentType : "other";
      logFor(laneId, p.g.conn.id).info("teams.send.read_back_form", { laneId, form });
      if (!sameText(m, p)) throw mismatch();
    },
  };
}
