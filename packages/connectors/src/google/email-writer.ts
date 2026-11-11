// The approvals-only Gmail write path (T-232): `email.send` and `email.save_draft`. A `ConnectorWriter` that only the
// approvals module may execute (rule 5): proposal -> a human approves the exact payload -> execute once -> verify -> audit.
// Exported only through the connectors write subpath; `api.ts` stays GET-only, the two POSTs live here.
//
// Before anything is sent, in this order: lane and connection brand, provider, the action's lane/connection, the approver,
// the payload hash (constant time), the authoritative connection row (status, `features.gmail_compose`), the lane's
// mailbox list, the target (mailbox = the connection's own mailbox), the payload schema, and `fromMailbox` = the mailbox.
//
// Never twice: the Message-ID is `<portal-{actionId}@{mailbox domain}>` and the message carries `X-Portal-Action-Id`.
// Before the POST the mailbox is searched for that Message-ID (`rfc822msgid:`); a hit skips the send. The POST itself is
// never retried by the HTTP client. If it fails in a way that may have been processed (timeout, 5xx, network), the mailbox
// is searched once more; no hit ends in `OUTCOME_UNKNOWN_MESSAGE` (a human checks the mailbox), never a blind resend.
import { timingSafeEqual } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { EmailComposeSchema, type EmailCompose } from "../comms/schemas";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { ExecResult } from "../contract/schemas";
import { computePayloadSha256, type ApprovedActionShape, type ConnectorWriter } from "../contract/writer";
import type { ConnectorResponse, HttpClient } from "../http/client";
import type { ConnectorLogger } from "../log/index";
import type { LaneConfigReader } from "../vault/lane-config";
import type { SecretValue } from "../vault/secret";
import type { GoogleApi } from "./api";
import { GMAIL_BASE, GMAIL_RATE_LIMIT } from "./constants";
import { assertGoogleConnection } from "./guard";
import { cleanText, decodeEncodedWords } from "./headers";
import { createGoogleHttp } from "./http";
import { buildRfc822, PORTAL_ACTION_HEADER, portalMessageId, toBase64Url } from "./mime-build";
import type { GoogleTokenManager } from "./token-manager";

export const GOOGLE_EMAIL_ACTIONS = ["email.send", "email.save_draft"] as const;
/** The connection feature set by the connect callback when Google granted `gmail.compose` (T-232). */
export const GMAIL_COMPOSE_FEATURE = "gmail_compose";
export const OUTCOME_UNKNOWN_MESSAGE = "The send outcome is unknown; check the mailbox before trying again";
export const VERIFICATION_MISMATCH_MESSAGE = "The message in the mailbox does not match the approved action";

/** T-193 replaces this with the branded `ApprovedAction`; until then the approver is carried explicitly. */
export type GoogleEmailApprovedAction = ApprovedActionShape & { readonly approved_by: string };

export type GoogleEmailWriterDeps = {
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  tokens: GoogleTokenManager;
  /** GET-only API (reads: lookup by Message-ID, the message replied to, read-back). */
  api: GoogleApi;
  laneConfig: Pick<LaneConfigReader, "mailboxes">;
  logger?: ConnectorLogger;
  now?: () => number;
  /** Test hook: the HTTP client for the Gmail host (POSTs). */
  httpFor?: (laneId: LaneId, conn: LaneBoundConnection<string>, baseUrl: string) => HttpClient;
};

export interface GoogleEmailWriter extends ConnectorWriter<GoogleEmailApprovedAction, "google"> {
  /** The same operation as the contract's write method, under the name tests use (the lint rule reserves that name for packages/modules/approvals, as the Google grant revoker does). */
  run: ConnectorWriter<GoogleEmailApprovedAction, "google">["executeWrite"];
  /** Reads the message back and compares thread, Message-ID, recipients and subject with the approved payload. Throws `VERIFICATION_MISMATCH_MESSAGE`. */
  verifyWrite(laneId: LaneId, conn: LaneBoundConnection<"google">, action: GoogleEmailApprovedAction, externalId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });
const PATH_MESSAGES = "/gmail/v1/users/me/messages";
const PATH_MESSAGE = "/gmail/v1/users/me/messages/{id}";
const PATH_SEND = "/gmail/v1/users/me/messages/send";
const PATH_DRAFTS = "/gmail/v1/users/me/drafts";
/** Failures after which the provider certainly did not create the message. */
const DEFINITE_KINDS: ReadonlySet<string> = new Set(["invalid_input", "forbidden", "reconnect_required", "unsupported_op", "lane_mismatch", "rate_limited", "not_found"]);

type MessageRef = { id: string; threadId?: string };
type MetaMessage = { id: string; threadId?: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };

function assertPayloadHash(action: GoogleEmailApprovedAction): void {
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

function header(m: MetaMessage, name: string): string | undefined {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
const addressSet = (value: string | undefined): string[] =>
  [...new Set((value ?? "").split(",").map((p) => (/<([^<>]+)>/.exec(p)?.[1] ?? p).trim().toLowerCase()).filter((p) => p !== ""))].sort();

export function createGoogleEmailWriter(deps: GoogleEmailWriterDeps): GoogleEmailWriter {
  const http = (laneId: LaneId, conn: LaneBoundConnection<string>): HttpClient =>
    deps.httpFor
      ? deps.httpFor(laneId, conn, GMAIL_BASE)
      : createGoogleHttp({ baseUrl: GMAIL_BASE, laneId, connectionId: conn.id, rateLimitKey: `${conn.id}:write`, rateLimit: GMAIL_RATE_LIMIT, ...(deps.logger ? { logger: deps.logger } : {}) });

  /** Every check that must pass before Gmail is called; returns the authoritative row and the parsed compose. */
  async function prepare(laneId: LaneId, conn: LaneBoundConnection<"google">, action: GoogleEmailApprovedAction) {
    assertLaneBound(laneId, conn);
    assertGoogleConnection(conn);
    if (action.lane_id !== laneId || action.connection_id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "The approved action is for another lane or connection" });
    if (!(GOOGLE_EMAIL_ACTIONS as readonly string[]).includes(action.action_type)) throw new ConnectorError({ kind: "unsupported_op", message: "Unsupported Google action" });
    if (typeof action.approved_by !== "string" || !UUID.test(action.approved_by)) throw refused("The approving user is required");
    if (typeof action.id !== "string" || !UUID.test(action.id)) throw refused("The action id is not valid");
    assertPayloadHash(action);
    const row = await deps.connections.load(laneId, conn.id);
    assertGoogleConnection(row);
    if (row.id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "Connection row does not match" });
    assertStatusUsable(row.status);
    if (row.features[GMAIL_COMPOSE_FEATURE] !== true) throw new ConnectorError({ kind: "forbidden", message: "This connection was not granted permission to send or save drafts" });
    const mailbox = row.external_account_id.toLowerCase();
    if (!(await deps.laneConfig.mailboxes(laneId)).includes(mailbox)) throw new ConnectorError({ kind: "forbidden", message: "This mailbox is not one of the lane's configured mailboxes" });
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

  async function findByMessageId(laneId: LaneId, conn: LaneBoundConnection<string>, messageId: string): Promise<MessageRef | null> {
    const res = await deps.api.get<{ messages?: MessageRef[] }>(laneId, conn, PATH_MESSAGES, undefined, {
      q: `rfc822msgid:${messageId.replace(/^<|>$/g, "")}`,
      maxResults: 1,
      includeSpamTrash: true,
    });
    const first = res.data?.messages?.[0];
    return first && typeof first.id === "string" ? first : null;
  }

  async function readMeta(laneId: LaneId, conn: LaneBoundConnection<string>, id: string, headers: string[]): Promise<MetaMessage> {
    const res = await deps.api.get<MetaMessage>(laneId, conn, PATH_MESSAGE, { id }, { format: "metadata", metadataHeaders: headers });
    if (!res.data || typeof res.data.id !== "string") throw new ConnectorError({ kind: "provider_error", message: "Gmail message is not valid" });
    return res.data;
  }

  async function post<T>(laneId: LaneId, conn: LaneBoundConnection<string>, path: string, body: unknown): Promise<ConnectorResponse<T>> {
    const client = http(laneId, conn);
    let used: SecretValue | undefined;
    const request = (rejected?: SecretValue) =>
      client.request<T>({
        method: "POST",
        path,
        body,
        retry: false, // never an automatic second send
        auth: {
          scheme: "Bearer",
          secret: async () => {
            used = await deps.tokens.accessToken(laneId, conn, rejected ? { rejected } : undefined);
            return used;
          },
        },
      });
    try {
      return await request();
    } catch (e) {
      // A 401 means the request was not processed: refresh once and try once more.
      if (isConnectorError(e) && e.info.kind === "forbidden" && e.info.http_status === 401 && used) return request(used);
      throw e;
    }
  }

  const executeWrite: GoogleEmailWriter["executeWrite"] = async (laneId, conn, action) => {
    const { row, compose, mailbox } = await prepare(laneId, conn, action);
    const executed_at = () => new Date((deps.now ?? Date.now)()).toISOString();
    const messageId = portalMessageId(action.id, mailbox);

    const existing = await findByMessageId(laneId, row, messageId);
    if (existing) return { outcome: "already_applied", external_id: existing.id, executed_at: executed_at(), provider_tid: null } satisfies ExecResult;

    let reply: { messageId: string; references: string } | undefined;
    if (compose.inReplyTo) {
      const parent = await readMeta(laneId, row, compose.inReplyTo.messageId, ["Message-ID", "References"]);
      const parentId = header(parent, "Message-ID");
      if (parent.threadId !== compose.inReplyTo.threadId || !parentId || /[\r\n]/.test(parentId)) throw refused("The message being replied to is not in the approved thread");
      const refs = (header(parent, "References") ?? "").replace(/\s+/g, " ").trim();
      reply = { messageId: parentId.trim(), references: `${refs} ${parentId.trim()}`.trim() };
    }
    const raw = toBase64Url(
      buildRfc822({ actionId: action.id, from: mailbox, to: compose.to, cc: compose.cc, bcc: compose.bcc, subject: compose.subject, bodyText: compose.bodyText, ...(reply ? { reply } : {}) }),
    );
    const threadId = compose.inReplyTo?.threadId;
    try {
      const res =
        action.action_type === "email.send"
          ? await post<{ id?: string }>(laneId, row, PATH_SEND, { raw, ...(threadId ? { threadId } : {}) })
          : await post<{ id?: string; message?: { id?: string } }>(laneId, row, PATH_DRAFTS, { message: { raw, ...(threadId ? { threadId } : {}) } });
      const data = res.data as { id?: string; message?: { id?: string } };
      const id = action.action_type === "email.send" ? data?.id : data?.message?.id;
      if (typeof id !== "string" || id === "") throw new ConnectorError({ kind: "provider_error", message: OUTCOME_UNKNOWN_MESSAGE });
      return { outcome: "accepted", external_id: id, executed_at: executed_at(), provider_tid: res.providerTid };
    } catch (e) {
      if (isConnectorError(e) && DEFINITE_KINDS.has(e.info.kind) && e.info.message !== OUTCOME_UNKNOWN_MESSAGE) throw e;
      // The provider may have processed it: look for the deterministic Message-ID once, and never send again.
      const found = await findByMessageId(laneId, row, messageId).catch(() => null);
      if (found) return { outcome: "already_applied", external_id: found.id, executed_at: executed_at(), provider_tid: null };
      throw new ConnectorError({ kind: "provider_error", message: OUTCOME_UNKNOWN_MESSAGE });
    }
  };

  return {
    provider: "google",
    actionTypes: GOOGLE_EMAIL_ACTIONS,
    executeWrite,
    run: executeWrite,
    async verifyWrite(laneId, conn, action, externalId) {
      const { row, compose, mailbox } = await prepare(laneId, conn, action);
      const mismatch = () => new ConnectorError({ kind: "provider_error", message: VERIFICATION_MISMATCH_MESSAGE });
      const m = await readMeta(laneId, row, externalId, ["Message-ID", "To", "Cc", "Subject", PORTAL_ACTION_HEADER]);
      const expectedLabel = action.action_type === "email.send" ? "SENT" : "DRAFT";
      const mid = header(m, "Message-ID")?.trim().toLowerCase();
      const marker = header(m, PORTAL_ACTION_HEADER)?.trim().toLowerCase();
      if (mid !== portalMessageId(action.id, mailbox) && marker !== action.id.toLowerCase()) throw mismatch();
      if (!(m.labelIds ?? []).includes(expectedLabel)) throw mismatch();
      if (compose.inReplyTo && m.threadId !== compose.inReplyTo.threadId) throw mismatch();
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (!same(addressSet(header(m, "To")), [...compose.to].sort())) throw mismatch();
      if (!same(addressSet(header(m, "Cc")), [...compose.cc].sort())) throw mismatch();
      if (cleanText(decodeEncodedWords(header(m, "Subject") ?? "")) !== cleanText(compose.subject)) throw mismatch();
    },
  };
}
