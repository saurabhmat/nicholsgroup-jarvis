// The only code path that revokes a QuickBooks grant at Intuit and deletes the stored tokens (T-050, decided D-24).
// Revoking calls Intuit's revocation endpoint: an external write, so it is a `ConnectorWriter` action that only the
// approvals module may execute (proposal -> a human approves the exact payload -> execute once -> verify -> audit). It
// is exported only through the `@nichols/connectors/write` subpath, never from the connector object, the connect
// flow or a route. The approvals proposal type for it comes with the approvals tasks (T-110+ / T-195); until then
// nothing in production calls this (a test enforces that).
//
// Fails closed: Intuit's answer decides whether the Vault tokens are deleted. Only a confirmed revocation or a 400
// invalid_token/invalid_grant ("already revoked or expired") deletes them; 401/403 (possibly our own wrong client
// credentials), 5xx and timeouts keep the tokens and fail, so the grant is never left live with nobody holding it.
// The approving user goes to the audit row of the Vault revocation.
//
// Verified before anything is sent to Intuit or changed in the Vault (security W1): the action's `payload_sha256` is
// recomputed (JCS + SHA-256 over lane, action type, connection, target, payload, schema version) and compared in
// constant time, and `target.realm_id` must be the connection's own QuickBooks company. A tampered payload or hash, or
// a target naming another company, is refused with `invalid_input`. `approved_by` is carried by the
// caller, but before anything is sent or changed the writer asks the approvals database (`claims.claimOpen`, core.act_claim_open)
// whether this exact action is executing with an open claim, the stored approved hash and that recorded approver (T-195 security
// review M2; same defence as the Gmail writer). A writer handed to the wrong code still cannot revoke anything that was not
// approved and claimed. The approvals executor (modules/approvals/src/server/qbo.ts) also reads both from the locked row.
import { timingSafeEqual } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { computePayloadSha256, type ConnectorWriter, type ApprovedActionShape } from "../contract/writer";
import { ConnectorError, isConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { ExecResult } from "../contract/schemas";
import type { HttpClient } from "../http/client";
import { defaultOAuthHttp, type OAuthProvider } from "../oauth/flow";
import type { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import type { ActionClaimReader } from "../vault/write-policy";
import type { IntuitEnvironment } from "./constants";
import type { Discovery } from "./discovery";
import { assertQuickbooksConnection } from "./guard";
import type { QboClientConfig } from "./provider";
import { isAlreadyRevoked, revokeGrant } from "./revoke";
import type { TokenManager } from "./token-manager";

/**
 * The approvals action type that disconnects QuickBooks (T-195). It is the same string end to end: the type stored in
 * act.proposed_actions, the one inside the approved hash and the one this writer accepts. (Before T-195 it was named
 * "qbo.revoke_grant"; the hash covers the type, so the connector and the proposal must agree on one name.)
 */
export const QBO_REVOKE_ACTION = "qbo.disconnect";

/**
 * T-193 replaces this with the branded `ApprovedAction`. Until then the approver is carried explicitly so the audit row
 * names the human who approved the revocation.
 */
export type QboApprovedAction = ApprovedActionShape & { readonly approved_by: string };

export type QboWriterDeps = {
  provider: OAuthProvider;
  environment: () => IntuitEnvironment;
  client: () => QboClientConfig;
  discovery: Discovery;
  vault: Pick<TokenVault, "revokeToken">;
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  tokens: TokenManager;
  /** The approvals database's check that the action is approved and claimed (core.act_claim_open). Fails closed. */
  claims: Pick<ActionClaimReader, "claimOpen">;
  now?: () => number;
  /** Test hook for the revocation host. */
  httpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

const TRANSIENT_KINDS: ReadonlySet<string> = new Set(["transient", "timeout", "rate_limited"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

/** Recomputes the approved hash; a missing, malformed or different hash (or an unhashable payload) is refused. */
function assertPayloadHash(action: QboApprovedAction): void {
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

/** The action's target must be exactly this connection's QuickBooks company. */
function assertTargetIsConnection(action: QboApprovedAction, row: LaneBoundConnection<string>): void {
  const target = action.target as Record<string, unknown> | null;
  const keys = target && typeof target === "object" ? Object.keys(target) : [];
  if (keys.length !== 1 || keys[0] !== "realm_id" || target?.realm_id !== row.external_account_id) {
    throw refused("The approved action targets another company");
  }
}

/**
 * The revoke-and-delete operation itself. Only `createQuickBooksWriter` (production, approvals-only) and the contract
 * kit's test harness build one; a test fails if any other production file does.
 */
export function createQuickBooksRevoker(deps: QboWriterDeps) {
  const now = deps.now ?? Date.now;
  const http = (laneId: LaneId, baseUrl: string) => (deps.httpFor ? deps.httpFor(laneId, baseUrl) : defaultOAuthHttp(deps.provider, laneId, baseUrl));

  return {
    async run(laneId: LaneId, conn: LaneBoundConnection<string>, action: QboApprovedAction): Promise<ExecResult> {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      if (action.lane_id !== laneId || action.connection_id !== conn.id) {
        throw new ConnectorError({ kind: "lane_mismatch", message: "The approved action is for another lane or connection" });
      }
      if (action.action_type !== QBO_REVOKE_ACTION) throw new ConnectorError({ kind: "unsupported_op", message: "Unsupported QuickBooks action" });
      if (typeof action.approved_by !== "string" || !UUID.test(action.approved_by)) {
        throw new ConnectorError({ kind: "invalid_input", message: "The approving user is required" });
      }
      assertPayloadHash(action);
      // Before the token read and any Intuit call: nothing is revoked unless the database has this action approved and claimed.
      if (!(await deps.claims.claimOpen(laneId, action.id, action.payload_sha256, action.approved_by))) {
        throw refused("This action is not approved and claimed for execution");
      }
      const row = await deps.connections.load(laneId, conn.id);
      assertQuickbooksConnection(row);
      assertTargetIsConnection(action, row);
      const executed_at = () => new Date(now()).toISOString();
      if (row.status === "disconnected") return { outcome: "already_applied", external_id: null, executed_at: executed_at(), provider_tid: null };

      let outcome: ExecResult["outcome"] = "accepted";
      let revokedAtIntuit = false;
      let providerTid: string | null = null;
      let refresh: SecretValue | null = null;
      try {
        refresh = await deps.tokens.refreshToken(laneId, row);
      } catch (e) {
        // Nothing usable stored (never stored, or not a token set): there is nothing to revoke at Intuit.
        if (!isConnectorError(e) || !["not_found", "connection_unavailable", "provider_error"].includes(e.info.kind)) throw e;
      }
      if (refresh) {
        try {
          const { revocation } = await deps.discovery.get(laneId, deps.environment());
          const { clientId, clientSecret } = deps.client();
          providerTid = (await revokeGrant({ http: http(laneId, new URL(revocation).origin), revocation, client: { clientId, clientSecret }, token: refresh })).providerTid;
          revokedAtIntuit = true;
        } catch (e) {
          if (isAlreadyRevoked(e)) {
            outcome = "already_applied";
            revokedAtIntuit = true;
          } else {
            const err = toConnectorError(e);
            if (TRANSIENT_KINDS.has(err.info.kind)) throw err;
            throw new ConnectorError({
              kind: "connection_unavailable",
              message: "QuickBooks did not confirm the revocation; the connection was not disconnected",
              ...(err.info.http_status != null ? { http_status: err.info.http_status } : {}),
              ...(err.info.provider_tid != null ? { provider_tid: err.info.provider_tid } : {}),
            });
          }
        }
      }
      try {
        await deps.vault.revokeToken(laneId, row, action.approved_by);
      } catch (e) {
        // Intuit has already ended the grant: never report "nothing changed" (T-195 security review L1).
        if (revokedAtIntuit) throw new ConnectorError({ kind: "transient", message: QBO_REVOKED_NOT_RECORDED_MESSAGE });
        throw e;
      }
      return { outcome, external_id: null, executed_at: executed_at(), provider_tid: providerTid };
    },
  };
}

/** The approvals-only write path (`@nichols/connectors/write`): the one way a QuickBooks grant is revoked. */
export function createQuickBooksWriter(deps: QboWriterDeps): ConnectorWriter<QboApprovedAction, "quickbooks"> {
  const revoker = createQuickBooksRevoker(deps);
  return {
    provider: "quickbooks",
    actionTypes: [QBO_REVOKE_ACTION],
    executeWrite: (laneId, conn, action) => revoker.run(laneId, conn, action),
  };
}

/** Intuit confirmed the revoke (or said it was already revoked) but the saved tokens could not be deleted / the row not marked. Fixed text. */
export const QBO_REVOKED_NOT_RECORDED_MESSAGE = "QuickBooks ended the connection but it could not be recorded here";

/** Shown (and stored as the failure) when the read-back finds the connection still usable after the revoke. Fixed text. */
export const QBO_VERIFICATION_MISMATCH_MESSAGE = "The QuickBooks connection is still connected after the disconnect";

export type QboDisconnectVerifierDeps = {
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  vault: Pick<TokenVault, "getToken">;
};

/**
 * The read-back after a disconnect (T-195): the authoritative connection row is `disconnected`, and the Vault no longer hands
 * out a token for it. (The database also guarantees the first implies the second: a connection cannot be marked disconnected
 * while a credential is stored, trigger connections_no_orphan_secret; the second read checks it anyway.) Read-only: no call to
 * Intuit. Throws a `provider_error` with the fixed message when either is not the case; a store that cannot be read throws as
 * it is (the approvals executor treats a failed read-back as "outcome unknown", never as "not disconnected").
 */
export function createQuickBooksDisconnectVerifier(deps: QboDisconnectVerifierDeps) {
  return {
    async verify(laneId: LaneId, conn: LaneBoundConnection<string>, action: Pick<QboApprovedAction, "lane_id" | "connection_id" | "target">): Promise<void> {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      if (action.lane_id !== laneId || action.connection_id !== conn.id) throw new ConnectorError({ kind: "lane_mismatch", message: "The approved action is for another lane or connection" });
      const row = await deps.connections.load(laneId, conn.id);
      assertQuickbooksConnection(row);
      assertTargetIsConnection(action as QboApprovedAction, row);
      if (row.status !== "disconnected") throw new ConnectorError({ kind: "provider_error", message: QBO_VERIFICATION_MISMATCH_MESSAGE });
      try {
        await deps.vault.getToken(laneId, row);
      } catch (e) {
        // The Vault refuses a disconnected connection (connection_unavailable) or has nothing stored (not_found): both are "gone".
        if (isConnectorError(e) && (e.info.kind === "connection_unavailable" || e.info.kind === "not_found")) return;
        throw e;
      }
      throw new ConnectorError({ kind: "provider_error", message: QBO_VERIFICATION_MISMATCH_MESSAGE });
    },
  };
}
