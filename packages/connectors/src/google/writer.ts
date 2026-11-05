// The only code path that revokes a Google grant and deletes the stored tokens (T-063, decided D-24). Same contract as
// the QuickBooks writer: a `ConnectorWriter` action that only the approvals module may execute (proposal -> a human
// approves the exact payload -> execute once -> verify -> audit). Exported only through the connectors write subpath.
// Verified before anything is sent to Google or changed in the Vault: lane/connection, payload hash (constant time),
// `target.mailbox` equals the connection's own mailbox. Fails closed: only a confirmed revocation or a 400
// invalid_token/invalid_grant deletes the Vault tokens; 401/403, 5xx and timeouts keep them and fail.
import { timingSafeEqual } from "node:crypto";
import type { LaneId } from "@nichols/core";
import { ConnectorError, isConnectorError, toConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import type { ExecResult } from "../contract/schemas";
import { computePayloadSha256, type ApprovedActionShape, type ConnectorWriter } from "../contract/writer";
import type { HttpClient } from "../http/client";
import type { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_HOSTS } from "./constants";
import { assertGoogleConnection } from "./guard";
import { createGoogleHttp } from "./http";
import { isAlreadyRevoked, revokeGoogleGrant } from "./revoke";
import type { GoogleTokenManager } from "./token-manager";

export const GOOGLE_REVOKE_ACTION = "google.revoke_grant";

/** T-193 replaces this with the branded `ApprovedAction`; until then the approver is carried explicitly for the audit row. */
export type GoogleApprovedAction = ApprovedActionShape & { readonly approved_by: string };

export type GoogleWriterDeps = {
  vault: Pick<TokenVault, "revokeToken">;
  connections: { load(laneId: LaneId, connectionId: string): Promise<LaneBoundConnection<string>> };
  tokens: GoogleTokenManager;
  now?: () => number;
  /** Test hook for the revocation host. */
  httpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

const TRANSIENT_KINDS: ReadonlySet<string> = new Set(["transient", "timeout", "rate_limited"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refused = (message: string) => new ConnectorError({ kind: "invalid_input", message });

function assertPayloadHash(action: GoogleApprovedAction): void {
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

function assertTargetIsConnection(action: GoogleApprovedAction, row: LaneBoundConnection<string>): void {
  const target = action.target as Record<string, unknown> | null;
  const keys = target && typeof target === "object" ? Object.keys(target) : [];
  if (keys.length !== 1 || keys[0] !== "mailbox" || target?.mailbox !== row.external_account_id) {
    throw refused("The approved action targets another mailbox");
  }
}

/** The revoke-and-delete operation itself; only `createGoogleWriter` and the test harness build one. */
export function createGoogleRevoker(deps: GoogleWriterDeps) {
  const now = deps.now ?? Date.now;
  const http = (laneId: LaneId, baseUrl: string) => (deps.httpFor ? deps.httpFor(laneId, baseUrl) : createGoogleHttp({ baseUrl, laneId }, GOOGLE_TOKEN_HOSTS));
  return {
    async run(laneId: LaneId, conn: LaneBoundConnection<string>, action: GoogleApprovedAction): Promise<ExecResult> {
      assertLaneBound(laneId, conn);
      assertGoogleConnection(conn);
      if (action.lane_id !== laneId || action.connection_id !== conn.id) {
        throw new ConnectorError({ kind: "lane_mismatch", message: "The approved action is for another lane or connection" });
      }
      if (action.action_type !== GOOGLE_REVOKE_ACTION) throw new ConnectorError({ kind: "unsupported_op", message: "Unsupported Google action" });
      if (typeof action.approved_by !== "string" || !UUID.test(action.approved_by)) {
        throw new ConnectorError({ kind: "invalid_input", message: "The approving user is required" });
      }
      assertPayloadHash(action);
      const row = await deps.connections.load(laneId, conn.id);
      assertGoogleConnection(row);
      assertTargetIsConnection(action, row);
      const executed_at = () => new Date(now()).toISOString();
      if (row.status === "disconnected") return { outcome: "already_applied", external_id: null, executed_at: executed_at(), provider_tid: null };

      let outcome: ExecResult["outcome"] = "accepted";
      let providerTid: string | null = null;
      let refresh: SecretValue | null = null;
      try {
        refresh = await deps.tokens.refreshToken(laneId, row);
      } catch (e) {
        if (!isConnectorError(e) || !["not_found", "connection_unavailable", "provider_error"].includes(e.info.kind)) throw e;
      }
      if (refresh) {
        try {
          const url = new URL(GOOGLE_REVOKE_URL);
          providerTid = (await revokeGoogleGrant({ http: http(laneId, url.origin), path: url.pathname, token: refresh })).providerTid;
        } catch (e) {
          if (isAlreadyRevoked(e)) {
            outcome = "already_applied";
          } else {
            const err = toConnectorError(e);
            if (TRANSIENT_KINDS.has(err.info.kind)) throw err;
            throw new ConnectorError({
              kind: "connection_unavailable",
              message: "Google did not confirm the revocation; the connection was not disconnected",
              ...(err.info.http_status != null ? { http_status: err.info.http_status } : {}),
            });
          }
        }
      }
      await deps.vault.revokeToken(laneId, row, action.approved_by);
      return { outcome, external_id: null, executed_at: executed_at(), provider_tid: providerTid };
    },
  };
}

/** The approvals-only write path (the connectors write subpath): the one way a Google grant is revoked. */
export function createGoogleWriter(deps: GoogleWriterDeps): ConnectorWriter<GoogleApprovedAction, "google"> {
  const revoker = createGoogleRevoker(deps);
  return {
    provider: "google",
    actionTypes: [GOOGLE_REVOKE_ACTION],
    executeWrite: (laneId, conn, action) => revoker.run(laneId, conn, action),
  };
}
