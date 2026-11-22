// The approvals-only Microsoft Graph email write path (T-262 Save as draft, T-263 Send): `email.save_draft` and `email.send`. A `ConnectorWriter` that only the approvals
// module may execute (rule 5): proposal -> the mailbox owner approves the exact payload -> execute once -> verify -> audit. Exported only through the connectors write
// subpath. Modelled on the Google writer; the provider-specific parts are checked against Microsoft's documentation (docs/plan-review.md, Nov 22, 2026, V-19, V-20).
//
// Before any request, in this order: lane and connection brand, provider, the action's lane and connection and type, the approver and action ids, the payload hash
// (constant time), then the Microsoft guard (authoritative row: status, Microsoft enabled for the lane, tenant, cloud, mail policy; no token read), the connection's
// `graph_mail_write` feature, the owner of the mailbox = the approver (T-247), the target, the payload schema and `fromMailbox` = the mailbox, and (execute only) the open
// execution claim in the approvals database.
//
// The marker is a single-value extended property holding the action id (V-19: custom internet headers can be set only when a message is created, so they cannot mark a
// reply draft; the property can be set by PATCH on a draft). A new message also carries the `X-Portal-Action-Id` header, but nothing ever depends on it. Lookup by marker
// is exactly `$filter=singleValueExtendedProperties/Any(ep: ep/id eq '<id>' and ep/value eq '<action id>')` on one folder (+ `$select`, `$top`): other clauses, `$orderby`
// and paging are not documented to combine with it. The marker is read back only with `$expand=singleValueExtendedProperties($filter=id eq '<id>')` on one message.
//
// save_draft: a reply is `createReply` in the approved conversation (the parent is read first and must be in it) then a PATCH of exactly the approved recipients,
// subject, body and the marker; a new message is one POST that carries all of it. send: the same draft, then `POST /me/messages/{id}/send` (202, empty body). The sent
// copy is then found in Sent Items by the marker (V-20: it "might not succeed immediately", so a few bounded retries), never by an assumed id.
//
// Never twice: before any create the writer looks for its own copy (Sent Items for send, Drafts for both); the POSTs are never retried by the HTTP client; after a
// failure that may have been processed (timeout, 5xx, network) the marker is searched twice and no hit ends in `OUTCOME_UNKNOWN_MESSAGE` (a human checks the mailbox):
// never a blind resend. A draft left by a failed run is only ever reused when it still carries the marker and still matches the approved text (a person may have edited
// it in Outlook: then nothing is sent). Nothing is ever deleted, moved or copied (the write client's allow-list has no such route).
//
// ONE EXECUTION: the approvals database's single execution claim (`claims.claimOpen`, checked first thing in `executeWrite`) is the ONLY guard against a second `executeWrite` of
// the same action. A second `executeWrite` after an `outcome_unknown` is FORBIDDEN (the writer cannot tell "never created" from "sent and not visible yet": a hidden sent copy with
// no draft left looks like nothing happened); recovery after an unknown outcome is `findWrite` / `verifyWrite` only (the reconciler). With the claim closed no Graph request is made.
//
// A draft this call did not create is never sent on a partial check: a marked draft found in Drafts BEFORE this run created one is not sent (a person is told to look); a draft
// recovered by marker after an ambiguous create or PATCH inside this call is accepted only after the FULL check (recipients, subject, conversation, sender, text body, no
// attachment, no Reply-To, plain-text content type). `email.save_draft` applies the same full check before it answers `already_applied`.
//
// A send that Graph accepted (202) but whose Sent Items copy is not visible yet is NOT a failure: the writer declares `sentCopyMayLag`, the approvals executor leaves the action
// `executing` with its claim at "sent", and the reconciler verifies it later: by the marker in Sent Items, or (the documentation does not say the extended property survives the
// send) by reading the message by the id returned at create and accepting it only if it is no longer a draft, sits in the Sent Items folder and matches the approved payload.
//
// Honest limits: a reply draft exists unmarked between createReply and the PATCH, so a crash in that gap leaves an unmarked draft that no lookup can attribute: the
// action ends `outcome_unknown` and a person looks in Drafts. A message body is never logged or put in an error.
import { timingSafeEqual } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { OUTCOME_UNKNOWN_MESSAGE, PORTAL_ACTION_HEADER, VERIFICATION_MISMATCH_MESSAGE } from "../comms/email-write";
import { EmailComposeSchema, type EmailCompose } from "../comms/schemas";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { ExecResult } from "../contract/schemas";
import { computePayloadSha256, type ApprovedActionShape, type ConnectorWriter } from "../contract/writer";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { assertMailAccountAllowed, readMailPolicy } from "../mail-policy";
import type { ActionClaimReader } from "../vault/write-policy";
import type { LaneConfigReader } from "../vault/lane-config";
import type { GraphApi } from "./api";
import { DRAFTS_FOLDER, GRAPH_MAIL_WRITE_FEATURE, PORTAL_MARKER_PROPERTY_ID, SENT_FOLDER } from "./constants";
import { assertMicrosoftConnection, type MicrosoftGuard } from "./guard";
import type { GraphWriteClient } from "./write-client";

export { OUTCOME_UNKNOWN_MESSAGE, VERIFICATION_MISMATCH_MESSAGE };
export const MICROSOFT_EMAIL_ACTIONS = ["email.send", "email.save_draft"] as const;
/** Shown (by the approvals card and as the writer's refusal) when the connection was not granted the write permissions. */
export const MICROSOFT_WRITE_NOT_GRANTED_MESSAGE = "Sending isn't enabled for this mailbox yet. Reconnect Microsoft with send permission in Settings";
export const DRAFT_CHANGED_MESSAGE = "The saved draft no longer matches the approved email, so it was not sent";
export const DRAFT_EXISTS_MESSAGE = "A draft carrying this action's marker already exists in Drafts, so nothing was sent. Check Drafts in Outlook";
export const NOT_IN_MAILBOX_MESSAGE = "The message was not found in the mailbox";

/** The approver is carried explicitly, as for Google (T-193 replaces this with the branded action). */
export type MicrosoftEmailApprovedAction = ApprovedActionShape & { readonly approved_by: string };

export type MicrosoftEmailWriterDeps = {
  /** The Microsoft guard (authoritative row, enabled provider, tenant, cloud, mail policy). Reads no token. */
  guard: MicrosoftGuard;
  /** GET-only API: marker lookups, the parent message, read-back. */
  api: GraphApi;
  /** The allow-listed POST / PATCH client. */
  write: GraphWriteClient;
  laneConfig: Pick<LaneConfigReader, "mailboxes" | "mailDomains">;
  /** The approvals database's check that this action is executing with an open claim. */
  claims: Pick<ActionClaimReader, "claimOpen">;
  logger?: ConnectorLogger;
  /** Waits between lookups (Sent Items can lag behind a send). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Pauses between the bounded lookups after an accepted send, and between the two lookups after an ambiguous failure. Defaults: [1000, 2000] and 2000. */
  sentRetryPausesMs?: readonly number[];
  ambiguousPauseMs?: number;
};

export interface MicrosoftEmailWriter extends ConnectorWriter<MicrosoftEmailApprovedAction, "microsoft"> {
  /** Provider-declared: after an accepted send the Sent Items copy may not be visible yet ("might not succeed immediately", V-20). The approvals executor then leaves the action for the reconciler. */
  readonly sentCopyMayLag: true;
  /**
   * Reads the message back by the marker and compares recipients, subject, conversation, sender and draft/sent state with the approved payload.
   * Throws `VERIFICATION_MISMATCH_MESSAGE` on a difference and `NOT_IN_MAILBOX_MESSAGE` (not_found) when no copy carries the marker. The id is never assumed:
   * `externalId` is used only to choose between several marked copies.
   */
  verifyWrite(laneId: LaneId, conn: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction, externalId: string): Promise<void>;
  /** Read-only marker lookup for recovery (T-192): the ids of this action's own copy (Sent Items for send, Drafts for save_draft), at most 5. Writes nothing. */
  findWrite(laneId: LaneId, conn: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction): Promise<string[]>;
}

/** What the reconciler may hold: look up and read back, never `executeWrite`. */
export type MicrosoftEmailReconciler = Pick<MicrosoftEmailWriter, "findWrite" | "verifyWrite">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });
/** Failures after which Microsoft certainly did not create or send anything. */
const DEFINITE_KINDS: ReadonlySet<string> = new Set(["invalid_input", "forbidden", "reconnect_required", "unsupported_op", "lane_mismatch", "rate_limited", "not_found", "connection_unavailable"]);
const PREFER = { Prefer: 'IdType="ImmutableId"' } as const;
const MESSAGES = "/me/messages";
const MESSAGE = "/me/messages/{id}";
const FOLDER_MESSAGES = "/me/mailFolders/{folder}/messages";
const CREATE_REPLY = "/me/messages/{id}/createReply";
const SEND = "/me/messages/{id}/send";
const MAX_LOOKUP = 5;

const AddressSchema = z.object({ emailAddress: z.object({ address: z.string().nullish() }).loose().nullish() }).loose();
const MessageSchema = z
  .object({
    id: z.string().min(1).max(512),
    conversationId: z.string().nullish(),
    subject: z.string().nullish(),
    isDraft: z.boolean().nullish(),
    from: AddressSchema.nullish(),
    toRecipients: z.array(AddressSchema).nullish(),
    ccRecipients: z.array(AddressSchema).nullish(),
    bccRecipients: z.array(AddressSchema).nullish(),
    body: z.object({ contentType: z.string().nullish(), content: z.string().nullish() }).loose().nullish(),
    hasAttachments: z.boolean().nullish(),
    replyTo: z.array(AddressSchema).nullish(),
    parentFolderId: z.string().nullish(),
    singleValueExtendedProperties: z.array(z.object({ id: z.string(), value: z.string().nullish() }).loose()).nullish(),
  })
  .loose();
type GraphMessage = z.infer<typeof MessageSchema>;
const ListSchema = z.object({ value: z.array(MessageSchema) }).loose();

function assertPayloadHash(action: MicrosoftEmailApprovedAction): void {
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

const addressesOf = (list: GraphMessage["toRecipients"]): string[] =>
  [...new Set((list ?? []).map((r) => (r.emailAddress?.address ?? "").trim().toLowerCase()).filter((a) => a !== ""))].sort();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const normBody = (s: string | null | undefined) => (s ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
const recipients = (list: readonly string[]) => list.map((address) => ({ emailAddress: { address } }));

export function createMicrosoftEmailWriter(deps: MicrosoftEmailWriterDeps): MicrosoftEmailWriter {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sentPauses = deps.sentRetryPausesMs ?? [1000, 2000];
  const ambiguousPause = deps.ambiguousPauseMs ?? 2000;
  const baseLog = deps.logger ?? connectorLog;
  /** A structured line with the lane, connection and ids only: never a body, a subject or a recipient. */
  const logFor = (laneId: LaneId, connectionId: string) => baseLog.child({ laneId, provider: "microsoft", connectionId });

  /** Every check that must pass before Graph is called; returns the authoritative row and the parsed compose. */
  async function prepare(laneId: LaneId, conn: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction) {
    assertLaneBound(laneId, conn);
    assertMicrosoftConnection(conn);
    if (typeof action !== "object" || action === null) throw refused("The approved action is not valid");
    if (action.lane_id !== laneId || action.connection_id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "The approved action is for another lane or connection" });
    if (!(MICROSOFT_EMAIL_ACTIONS as readonly string[]).includes(action.action_type)) throw new ConnectorError({ kind: "unsupported_op", message: "Unsupported Microsoft action" });
    if (typeof action.approved_by !== "string" || !UUID.test(action.approved_by)) throw refused("The approving user is required");
    if (typeof action.id !== "string" || !UUID.test(action.id)) throw refused("The action id is not valid");
    assertPayloadHash(action);
    const g = await deps.guard(laneId, conn); // the authoritative row, usable, Microsoft enabled for the lane, tenant, cloud, mail policy: no token read
    const row = g.conn;
    if (row.id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection row does not match" });
    if (row.features[GRAPH_MAIL_WRITE_FEATURE] !== true) throw new ConnectorError({ kind: "forbidden", message: MICROSOFT_WRITE_NOT_GRANTED_MESSAGE });
    const mailbox = row.external_account_id.toLowerCase();
    assertMailAccountAllowed(await readMailPolicy(deps.laneConfig, laneId), mailbox);
    // T-247: only the mailbox's owner sends from it (the approver the database recorded is the owner: act.approve), checked again here.
    if (typeof row.owner_user_id !== "string" || row.owner_user_id !== action.approved_by) throw new ConnectorError({ kind: "forbidden", message: "Only the mailbox's owner can send from it" });
    const target = action.target as Record<string, unknown> | null;
    const keys = target && typeof target === "object" ? Object.keys(target).sort() : [];
    const okKeys = keys.length === 1 ? keys[0] === "mailbox" : keys.length === 2 && keys[0] === "mailbox" && keys[1] === "thread_id";
    if (!okKeys || String(target?.mailbox).toLowerCase() !== mailbox) throw refused("The approved action targets another mailbox");
    const parsed = EmailComposeSchema.safeParse(action.payload);
    if (!parsed.success) throw refused("The approved email is not valid");
    const compose: EmailCompose = parsed.data;
    if (compose.fromMailbox.toLowerCase() !== mailbox) throw refused("The sender is not this connection's mailbox");
    if ((compose.inReplyTo?.threadId ?? undefined) !== (target?.thread_id as string | undefined)) throw refused("The reply thread does not match the target");
    return { row, compose, mailbox };
  }

  const markerFilter = (actionId: string) => `singleValueExtendedProperties/Any(ep: ep/id eq '${PORTAL_MARKER_PROPERTY_ID}' and ep/value eq '${actionId}')`;

  const fromIs = (m: GraphMessage, mailbox: string): boolean | null => {
    const a = m.from?.emailAddress?.address;
    return typeof a === "string" && a.trim() !== "" ? a.trim().toLowerCase() === mailbox : null;
  };

  /**
   * The ONE lookup of "is this action's message already in this folder", shared by the execute path, the reconciler's `findWrite` and the read-back. Exactly the
   * marker filter on one folder, `$select` and `$top` (nothing else is documented to combine with it). A hit counts only when it is not a draft in Sent Items / is a
   * draft in Drafts, and its From (when Graph returns one; a draft may have none) is the sending mailbox.
   */
  async function findOwn(laneId: LaneId, row: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction, mailbox: string, folder: typeof DRAFTS_FOLDER | typeof SENT_FOLDER): Promise<string[]> {
    const res = await deps.api.get(laneId, row, FOLDER_MESSAGES, { folder }, { $filter: markerFilter(action.id), $select: "id,from,isDraft", $top: MAX_LOOKUP }, { headers: PREFER });
    const parsed = ListSchema.safeParse(res.data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Microsoft message list is not valid" });
    const own: string[] = [];
    for (const m of parsed.data.value.slice(0, MAX_LOOKUP)) {
      const from = fromIs(m, mailbox);
      if (from === false) continue; // another sender's message carrying our property: never ours
      if (folder === SENT_FOLDER && (from !== true || m.isDraft === true)) continue;
      if (folder === DRAFTS_FOLDER && m.isDraft === false) continue;
      own.push(m.id);
    }
    return own;
  }

  /** After an ambiguous failure: look twice (the second after a pause); the first id found, or undefined. A failing lookup counts as "not found". */
  async function recover(laneId: LaneId, row: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction, mailbox: string, folder: typeof DRAFTS_FOLDER | typeof SENT_FOLDER, stage: "create" | "patch" | "send"): Promise<string | undefined> {
    let found = (await findOwn(laneId, row, action, mailbox, folder).catch(() => []))[0];
    if (!found) {
      await sleep(ambiguousPause);
      found = (await findOwn(laneId, row, action, mailbox, folder).catch(() => []))[0];
    }
    logFor(laneId, row.id).warn("microsoft.write.recovery", { action_id: action.id, stage, outcome: found ? "found" : "not_found", ...(found ? { message_id: found } : {}) });
    return found;
  }

  const isAmbiguous = (e: unknown): boolean => !(isConnectorError(e) && DEFINITE_KINDS.has(e.info.kind) && e.info.message !== OUTCOME_UNKNOWN_MESSAGE);
  const unknown = () => new ConnectorError({ kind: "provider_error", message: OUTCOME_UNKNOWN_MESSAGE });

  const parseMessage = (data: unknown): GraphMessage => {
    const p = MessageSchema.safeParse(data);
    if (!p.success) throw new ConnectorError({ kind: "provider_error", message: "Microsoft message is not valid" });
    return p.data;
  };

  /** The draft Microsoft returned must be what was approved (recipients, subject, conversation): checked before anything is sent. */
  function assertDraftMatches(m: GraphMessage, compose: EmailCompose, mailbox: string, full: boolean): void {
    const bad = () => new ConnectorError({ kind: "invalid_input", message: DRAFT_CHANGED_MESSAGE });
    if (full) {
      // The FULL check (a draft this call did not just create): no attachment, no Reply-To, the stored content type is plain text (read WITHOUT the text-conversion
      // header, so an HTML body that merely renders to the same text is a difference), and the text is exactly the approved one.
      if (m.isDraft !== true || m.hasAttachments !== false || (m.replyTo ?? []).length > 0 || (m.body?.contentType ?? "").toLowerCase() !== "text") throw bad();
    }
    if (m.isDraft === false) throw bad();
    if (fromIs(m, mailbox) === false) throw bad();
    if (!sameList(addressesOf(m.toRecipients), [...compose.to].sort())) throw bad();
    if (!sameList(addressesOf(m.ccRecipients), [...compose.cc].sort())) throw bad();
    if (!sameList(addressesOf(m.bccRecipients), [...compose.bcc].sort())) throw bad();
    if (norm(m.subject) !== norm(compose.subject)) throw bad();
    if (compose.inReplyTo && m.conversationId !== compose.inReplyTo.threadId) throw bad();
    if (full && normBody(m.body?.content) !== normBody(compose.bodyText)) throw bad();
  }

  /** Creates the marked draft (a new message, or createReply + PATCH) and returns its id. */
  async function createDraft(laneId: LaneId, row: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction, compose: EmailCompose, mailbox: string): Promise<string> {
    const content = {
      subject: compose.subject,
      body: { contentType: "text", content: compose.bodyText },
      toRecipients: recipients(compose.to),
      ccRecipients: recipients(compose.cc),
      bccRecipients: recipients(compose.bcc),
    };
    const marker = [{ id: PORTAL_MARKER_PROPERTY_ID, value: action.id }];

    if (!compose.inReplyTo) {
      try {
        const res = await deps.write.request(laneId, row, { method: "POST", path: MESSAGES, body: { ...content, internetMessageHeaders: [{ name: PORTAL_ACTION_HEADER, value: action.id }], singleValueExtendedProperties: marker } });
        const m = parseMessage(res.data);
        assertDraftMatches(m, compose, mailbox, false);
        return m.id;
      } catch (e) {
        if (!isAmbiguous(e)) throw e;
        const found = await recover(laneId, row, action, mailbox, DRAFTS_FOLDER, "create");
        if (found) {
          await fullCheckDraft(laneId, row, compose, mailbox, found); // recovered, not seen created: the FULL check before it is used
          return found;
        }
        throw unknown();
      }
    }

    // A reply: the parent is read first and must be in the approved conversation.
    const parent = parseMessage((await deps.api.get(laneId, row, MESSAGE, { id: compose.inReplyTo.messageId }, { $select: "id,conversationId,isDraft" }, { headers: PREFER })).data);
    if (parent.conversationId !== compose.inReplyTo.threadId) throw refused("The message being replied to is not in the approved conversation");
    let draftId: string;
    try {
      const res = await deps.write.request(laneId, row, { method: "POST", path: CREATE_REPLY, params: { id: parent.id }, body: {} });
      const created = parseMessage(res.data);
      if (created.isDraft === false || (created.conversationId ?? compose.inReplyTo.threadId) !== compose.inReplyTo.threadId) throw refused("The reply draft is not in the approved conversation");
      draftId = created.id;
    } catch (e) {
      if (!isAmbiguous(e)) throw e;
      // createReply carries no marker, so a lookup cannot attribute a draft to this action: a human checks Drafts.
      logFor(laneId, row.id).warn("microsoft.write.unmarked_reply_draft", { action_id: action.id, reason: "create_reply_ambiguous" });
      throw unknown();
    }
    // PATCH only the draft this very call created (its id came from our own createReply response above; the write client only limits which fields can be sent).
    try {
      const res = await deps.write.request(laneId, row, { method: "PATCH", path: MESSAGE, params: { id: draftId }, body: { ...content, singleValueExtendedProperties: marker } });
      assertDraftMatches(parseMessage(res.data), compose, mailbox, false);
      return draftId;
    } catch (e) {
      if (!isAmbiguous(e)) {
        logFor(laneId, row.id).warn("microsoft.write.unmarked_reply_draft", { action_id: action.id, draft_id: draftId, reason: "patch_refused" });
        throw e;
      }
      const found = await recover(laneId, row, action, mailbox, DRAFTS_FOLDER, "patch");
      if (found) {
        await fullCheckDraft(laneId, row, compose, mailbox, found);
        return found;
      }
      logFor(laneId, row.id).warn("microsoft.write.unmarked_reply_draft", { action_id: action.id, draft_id: draftId, reason: "patch_ambiguous" });
      throw unknown();
    }
  }

  /**
   * The FULL check of a draft this call did not create (found by marker before a create, or recovered after an ambiguous failure): every difference refuses.
   * Read WITHOUT the text-conversion header, so the stored content type is what is checked.
   */
  async function fullCheckDraft(laneId: LaneId, row: LaneBoundConnection<"microsoft">, compose: EmailCompose, mailbox: string, id: string): Promise<void> {
    const res = await deps.api.get(laneId, row, MESSAGE, { id }, { $select: "id,conversationId,subject,isDraft,from,toRecipients,ccRecipients,bccRecipients,replyTo,hasAttachments,body" }, { headers: PREFER });
    assertDraftMatches(parseMessage(res.data), compose, mailbox, true);
  }

  /** The sent copy by the marker, with a few bounded retries (it may not be in Sent Items at once, V-20). */
  async function findSentWithRetries(laneId: LaneId, row: LaneBoundConnection<"microsoft">, action: MicrosoftEmailApprovedAction, mailbox: string): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      const ids = await findOwn(laneId, row, action, mailbox, SENT_FOLDER).catch((e: unknown) => {
        if (attempt >= sentPauses.length) throw e;
        return [] as string[];
      });
      if (ids.length > 0 || attempt >= sentPauses.length) return ids;
      await sleep(sentPauses[attempt] ?? 2000);
    }
  }

  const executeWrite: MicrosoftEmailWriter["executeWrite"] = async (laneId, conn, action) => {
    const { row, compose, mailbox } = await prepare(laneId, conn, action);
    // Defence in depth: whoever holds this writer, nothing is created or sent unless the approvals database has this exact action approved (same hash, same approver)
    // and claimed with nothing sent yet.
    if (!(await deps.claims.claimOpen(laneId, action.id, action.payload_sha256, action.approved_by))) {
      throw new ConnectorError({ kind: "forbidden", message: "This action is not approved and claimed for execution" });
    }
    const executed_at = () => new Date((deps.now ?? Date.now)()).toISOString();
    const done = (outcome: ExecResult["outcome"], external_id: string, provider_tid: string | null = null): ExecResult => ({ outcome, external_id, executed_at: executed_at(), provider_tid });
    const isSend = action.action_type === "email.send";

    if (isSend) {
      const sent = (await findOwn(laneId, row, action, mailbox, SENT_FOLDER))[0];
      if (sent) return done("already_applied", sent);
    }
    const existing = (await findOwn(laneId, row, action, mailbox, DRAFTS_FOLDER))[0];
    if (existing) {
      // Not created by this call. A send never uses it (a person may have touched it, and a partial check is not enough to send on): nothing is sent and the person is told to look.
      if (isSend) throw new ConnectorError({ kind: "invalid_input", message: DRAFT_EXISTS_MESSAGE });
      // save_draft: it is already_applied only if the FULL check passes; a different draft is not "already applied".
      await fullCheckDraft(laneId, row, compose, mailbox, existing);
      return done("already_applied", existing);
    }
    const draftId = await createDraft(laneId, row, action, compose, mailbox);
    if (!isSend) return done("accepted", draftId);

    try {
      const res = await deps.write.request(laneId, row, { method: "POST", path: SEND, params: { id: draftId }, body: {} });
      // 202 Accepted. The sent copy is found by the marker (its id is not assumed); when it is not there yet the draft id is recorded and the read-back finds the copy.
      const copy = (await findSentWithRetries(laneId, row, action, mailbox).catch(() => []))[0];
      return done("accepted", copy ?? draftId, res.providerTid);
    } catch (e) {
      if (!isAmbiguous(e)) throw e;
      // The send may have been processed: look twice, and never send again.
      const found = await recover(laneId, row, action, mailbox, SENT_FOLDER, "send");
      if (found) return done("already_applied", found);
      throw unknown();
    }
  };

  return {
    provider: "microsoft",
    sentCopyMayLag: true as const,
    actionTypes: MICROSOFT_EMAIL_ACTIONS,
    executeWrite,
    async findWrite(laneId, conn, action) {
      const { row, mailbox } = await prepare(laneId, conn, action);
      return findOwn(laneId, row, action, mailbox, action.action_type === "email.send" ? SENT_FOLDER : DRAFTS_FOLDER);
    },
    async verifyWrite(laneId, conn, action, externalId) {
      const { row, compose, mailbox } = await prepare(laneId, conn, action);
      const mismatch = () => new ConnectorError({ kind: "provider_error", message: VERIFICATION_MISMATCH_MESSAGE });
      const notFound = () => new ConnectorError({ kind: "not_found", message: NOT_IN_MAILBOX_MESSAGE });
      const isSend = action.action_type === "email.send";
      /** Recipients, subject, conversation, sender and state of a message against the approved payload. Bcc: on a draft strictly; on a sent copy only when Graph returns some (a sent copy may not list it). */
      const compare = (m: GraphMessage) => {
        const from = fromIs(m, mailbox);
        if (from === false || (isSend && from !== true)) throw mismatch();
        if (isSend ? m.isDraft !== false : m.isDraft === false) throw mismatch();
        if (compose.inReplyTo && m.conversationId !== compose.inReplyTo.threadId) throw mismatch();
        if (!sameList(addressesOf(m.toRecipients), [...compose.to].sort())) throw mismatch();
        if (!sameList(addressesOf(m.ccRecipients), [...compose.cc].sort())) throw mismatch();
        const bcc = addressesOf(m.bccRecipients);
        if ((!isSend || bcc.length > 0) && !sameList(bcc, [...compose.bcc].sort())) throw mismatch();
        if (norm(m.subject) !== norm(compose.subject)) throw mismatch();
      };
      const ids = isSend ? await findSentWithRetries(laneId, row, action, mailbox) : await findOwn(laneId, row, action, mailbox, DRAFTS_FOLDER);
      if (ids.length === 0) {
        if (!isSend) throw notFound();
        // The documentation does not say the extended property survives the send. Second way: the message by the id returned at create (the ImmutableId preference is on every
        // request), accepted as the sent copy only if it is no longer a draft, sits in the Sent Items folder and matches the approved payload. Read routes only.
        const folder = z.object({ id: z.string().min(1) }).loose().safeParse((await deps.api.get(laneId, row, "/me/mailFolders/{name}", { name: SENT_FOLDER }, { $select: "id" }, { headers: PREFER })).data);
        if (!folder.success) throw new ConnectorError({ kind: "provider_error", message: "Microsoft folder is not valid" });
        let byId: GraphMessage;
        try {
          byId = parseMessage((await deps.api.get(laneId, row, MESSAGE, { id: externalId }, { $select: "id,conversationId,subject,isDraft,from,toRecipients,ccRecipients,bccRecipients,parentFolderId" }, { headers: PREFER })).data);
        } catch (e) {
          if (isConnectorError(e) && e.info.kind === "not_found") throw notFound();
          throw e;
        }
        if (byId.isDraft !== false || byId.parentFolderId !== folder.data.id) throw notFound(); // still a draft, or somewhere else: not (yet) the sent copy
        compare(byId);
        return;
      }
      const id = ids.includes(externalId) ? externalId : ids.length === 1 ? (ids[0] as string) : undefined;
      if (id === undefined) throw mismatch(); // several marked copies and none is the recorded one
      const res = await deps.api.get(
        laneId,
        row,
        MESSAGE,
        { id },
        { $select: "id,conversationId,subject,isDraft,from,toRecipients,ccRecipients,bccRecipients", $expand: `singleValueExtendedProperties($filter=id eq '${PORTAL_MARKER_PROPERTY_ID}')` },
        { headers: PREFER },
      );
      const m = parseMessage(res.data);
      const marker = (m.singleValueExtendedProperties ?? []).find((p) => p.id.toLowerCase() === PORTAL_MARKER_PROPERTY_ID.toLowerCase());
      if ((marker?.value ?? "").trim().toLowerCase() !== action.id.toLowerCase()) throw mismatch();
      compare(m);
    },
  };
}
