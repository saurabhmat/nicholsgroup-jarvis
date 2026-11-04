// The QuickBooks Online connector (T-050), read-only. It implements the shared connector contract:
//  - connect: completes an in-app OAuth callback (the authorization code + the realm the callback named). It is the
//    only way a token set enters the Vault, besides the connect flow's own callback, which does the same steps; a
//    `vault_secret` reference, an OAuth Playground token or an offline token is refused (QB-7).
//  - health: reads CompanyInfo (one cheap authenticated call) and reports; it does not throw for connection problems.
//  - read: `company_info` for now (T-051 and T-052 add entities and reports).
//  - disconnect: revokes the refresh token at Intuit and deletes the Vault tokens (minimal; T-195 adds the error map,
//    audit actor and reconnect handling).
// No sync, subscribe or prepareWrite: QuickBooks is read-only in the pilot.
import type { LaneId } from "@nichols/core";
import type { Connector } from "../contract/connector";
import { ConnectorError, toConnectorError } from "../contract/errors";
import { assertStatusUsable } from "../contract/guards";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { ConnectInputSchema, LaneIdSchema, ReadOpSchema, type HealthStatus } from "../contract/schemas";
import { basicCredentials, type HttpClient } from "../http/client";
import { exchangeAuthorizationCode, defaultOAuthHttp, type OAuthProvider } from "../oauth/flow";
import type { ConnectorLogger } from "../log/index";
import { SecretValue } from "../vault/secret";
import type { ConnectionStore } from "../vault/connections";
import type { LaneConfigReader } from "../vault/lane-config";
import type { TokenVault } from "../vault/tokens";
import type { QboApi } from "./api";
import { fetchCompanyInfo } from "./company-info";
import type { Discovery } from "./discovery";
import type { IntuitEnvironment } from "./constants";
import { refreshExpiry, type QboClientConfig } from "./provider";
import { assertRealmAllowed } from "./realm";
import type { TokenManager } from "./token-manager";

type QboProvider = "quickbooks";
export type QboConnection = LaneBoundConnection<QboProvider>;

export const QBO_READ_OPS = ["company_info"] as const;
/** Edition features T-051 detects from Preferences; declared here so the contract knows them. */
export const QBO_FEATURE_KEYS = ["class_tracking", "location_tracking", "multicurrency"] as const;

export type QboConnectorDeps = {
  provider: OAuthProvider;
  environment: () => IntuitEnvironment;
  client: () => QboClientConfig;
  discovery: Discovery;
  laneConfig: LaneConfigReader;
  vault: Pick<TokenVault, "storeToken" | "revokeToken">;
  connections: Pick<ConnectionStore, "ensureConnection"> & {
    /** The authoritative row by (lane, id): `not_found` for a missing row or another lane's. */
    load(laneId: LaneId, connectionId: string): Promise<QboConnection>;
  };
  tokens: TokenManager;
  api: QboApi;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Test hook for the OAuth token and revocation hosts. */
  httpFor?: (laneId: LaneId, baseUrl: string) => HttpClient;
};

const TRANSIENT_KINDS: ReadonlySet<string> = new Set(["transient", "timeout", "rate_limited"]);

export function createQuickBooksConnector(deps: QboConnectorDeps): Connector<QboProvider> {
  const now = deps.now ?? Date.now;
  const oauthHttp = (laneId: LaneId, baseUrl: string) => (deps.httpFor ? deps.httpFor(laneId, baseUrl) : defaultOAuthHttp(deps.provider, laneId, baseUrl, deps.logger));

  /** Brand + lane check, then the authoritative row. */
  async function loadRow(laneId: LaneId, conn: unknown): Promise<QboConnection> {
    assertLaneBound(laneId, conn);
    return deps.connections.load(laneId, conn.id) as Promise<QboConnection>;
  }

  /** Authoritative status must be usable (active or degraded); `reconnect_required` is never retried. */
  async function useConnection(laneId: LaneId, conn: unknown): Promise<QboConnection> {
    const row = await loadRow(laneId, conn);
    assertStatusUsable(row.status);
    return row;
  }

  return {
    provider: "quickbooks",
    capabilities: { sync: false, subscribe: false, prepareWrite: false },
    readOps: QBO_READ_OPS,
    featureKeys: QBO_FEATURE_KEYS,

    async connect(laneId, input) {
      if (!LaneIdSchema.safeParse(laneId).success) throw new ConnectorError({ kind: "invalid_input", message: "laneId is required" });
      const parsed = ConnectInputSchema.safeParse(input);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid connect input" });
      const data = parsed.data;
      // QB-7: tokens come only from the in-app authorization flow, never from a stored secret reference, the OAuth
      // Playground or an offline token.
      if (data.kind !== "oauth_code") {
        throw new ConnectorError({ kind: "invalid_input", message: "QuickBooks connects only through the in-app authorization flow" });
      }
      const realm = data.external_account_id;
      if (realm === undefined) throw new ConnectorError({ kind: "invalid_input", message: "The QuickBooks company (realmId) is required" });
      const { redirectUri } = deps.provider.client();
      if (data.redirect_uri !== redirectUri) throw new ConnectorError({ kind: "invalid_input", message: "redirect_uri is not the registered one" });

      if (data.reconnect_connection_id !== undefined) {
        // Same lane (not_found otherwise) and the same company.
        const existing = await deps.connections.load(laneId, data.reconnect_connection_id);
        if (existing.provider !== "quickbooks" || existing.external_account_id !== realm) {
          throw new ConnectorError({ kind: "invalid_input", message: "Reconnect must use the same QuickBooks company" });
        }
      }
      await assertRealmAllowed(deps.laneConfig, laneId, realm);

      const tokens = await exchangeAuthorizationCode(deps.provider, (_p, lane, baseUrl) => oauthHttp(lane, baseUrl), laneId, data.code, data.code_verifier, redirectUri);
      const conn = await deps.connections.ensureConnection(laneId, "quickbooks", realm);
      await deps.vault.storeToken(
        laneId,
        conn,
        new SecretValue(JSON.stringify({ ...tokens, obtained_at: new Date(now()).toISOString() })),
        refreshExpiry(tokens, now()),
      );
      return deps.connections.load(laneId, conn.id);
    },

    async health(laneId, conn): Promise<HealthStatus> {
      const row = await loadRow(laneId, conn);
      const checked_at = new Date(now()).toISOString();
      const problem = (e: unknown, status: HealthStatus["status"]): HealthStatus => {
        const error = toConnectorError(e);
        return { ok: false, status, checked_at, provider_tid: error.info.provider_tid, error: error.toJSON() };
      };
      try {
        assertStatusUsable(row.status);
      } catch (e) {
        return problem(e, row.status);
      }
      try {
        const { providerTid } = await fetchCompanyInfo(deps.api, laneId, row);
        return { ok: true, status: "active", checked_at, provider_tid: providerTid, error: null };
      } catch (e) {
        const err = toConnectorError(e);
        return problem(err, err.info.kind === "reconnect_required" ? "reconnect_required" : "degraded");
      }
    },

    async read<T = unknown>(laneId: LaneId, conn: QboConnection, op: Parameters<Connector["read"]>[2]) {
      const row = await useConnection(laneId, conn);
      const parsed = ReadOpSchema.safeParse(op);
      if (!parsed.success) throw new ConnectorError({ kind: "invalid_input", message: "Invalid read op" });
      if (!(QBO_READ_OPS as readonly string[]).includes(parsed.data.op)) {
        throw new ConnectorError({ kind: "unsupported_op", message: `Unsupported read op ${parsed.data.op}` });
      }
      const fetched_at = new Date(now()).toISOString();
      const { info, asOf, providerTid } = await fetchCompanyInfo(deps.api, laneId, row);
      return {
        lane_id: laneId,
        provider: "quickbooks" as const,
        connection_id: row.id,
        op: parsed.data.op,
        data: info as T,
        // The data cannot reflect a moment after we fetched it: clamp a provider clock that runs ahead of ours.
        as_of: asOf !== null && asOf < fetched_at ? asOf : fetched_at,
        fetched_at,
        freshness: "live" as const,
        provider_tid: providerTid,
        source_refs: [{ kind: "qbo_company", ref: row.external_account_id }],
        notes: [],
      };
    },

    async disconnect(laneId, conn) {
      const row = await loadRow(laneId, conn);
      // Revoke the refresh token at Intuit first. A transient failure stops here (nothing deleted, retry later); a
      // token Intuit no longer knows (already revoked or expired) is not a reason to keep ours.
      if (row.status !== "disconnected") {
        let refresh: SecretValue | null = null;
        try {
          refresh = await deps.tokens.refreshToken(laneId, row);
        } catch (e) {
          if (!(e instanceof ConnectorError) || !["not_found", "connection_unavailable", "provider_error"].includes(e.info.kind)) throw e;
        }
        if (refresh) {
          try {
            const { revocation } = await deps.discovery.get(laneId, deps.environment());
            const url = new URL(revocation);
            const { clientId, clientSecret } = deps.client();
            await oauthHttp(laneId, url.origin).request({
              method: "POST",
              path: url.pathname,
              body: { token: refresh.reveal() },
              auth: { scheme: "Basic", secret: basicCredentials(clientId, clientSecret) },
              retry: true,
            });
          } catch (e) {
            if (e instanceof ConnectorError && TRANSIENT_KINDS.has(e.info.kind)) throw e;
            if (!(e instanceof ConnectorError)) throw toConnectorError(e);
            // 400/401/403/404 from the revoke call: the token is not valid at Intuit any more.
          }
        }
      }
      await deps.vault.revokeToken(laneId, row);
      return deps.connections.load(laneId, row.id);
    },
  };
}
