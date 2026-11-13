// QuickBooks access tokens (QB-2, T-050). The Vault holds one JSON token set per connection. This module hands out a
// usable access token: refreshed proactively when it has less than REFRESH_SKEW_MS left, and refreshed on demand when
// Intuit answered 401 for the one we used.
//
// Intuit rotates the refresh token on refresh. Losing the new one means a forced reconnect, so:
//  - refreshes for one connection are single-flight within a process (concurrent callers share one request);
//  - across processes (refresh-on-401 runs inline on several serverless instances) the store is a compare-and-swap:
//    `rotateToken` names the stored text it replaces, and the database refuses (40001) if another refresh already
//    stored a newer set. The loser discards its own result and uses the winner's stored token;
//  - the new set is stored in the same step that discards the old one (one Vault secret per connection), so there is
//    never a moment with two stored refresh tokens or none.
// The refresh POST is never retried once it may have been sent: if Intuit rotates the token on the first request, a
// repeat with the old one is `invalid_grant`. When the POST times out, or Intuit answers `invalid_grant`, the Vault is
// read again: if the stored set changed, another instance won the race and its set is used, whatever grace period
// Intuit does or does not give the previous refresh token. Only an unchanged store means `reconnect_required` (QB-3,
// QB-4); recording that status and notifying the admin is `onReconnectRequired` (T-195, ./reconnect.ts).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { basicCredentials, createHttpClient, type HttpClient } from "../http/client";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { TokenResponseSchema } from "../oauth/flow";
import type { TokenVault } from "../vault/tokens";
import { SecretValue } from "../vault/secret";
import { INTUIT_TID_HEADER, REFRESH_SKEW_MS } from "./constants";
import { assertQuickbooksConnection } from "./guard";
import type { OnReconnectRequired } from "./reconnect";

const StoredSchema = z.looseObject({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().positive().optional(),
  x_refresh_token_expires_in: z.number().positive().optional(),
  obtained_at: z.iso.datetime({ offset: true }),
});

/** A token set as stored, parsed. `raw` is the exact stored text (the compare-and-swap names it). */
export type StoredTokens = {
  raw: SecretValue;
  access: SecretValue;
  refresh: SecretValue;
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
};

export type TokenManagerDeps = {
  vault: Pick<TokenVault, "getToken" | "rotateToken">;
  /** The token endpoint (from discovery). */
  tokenEndpoint: (laneId: LaneId) => Promise<string>;
  client: () => { clientId: string; clientSecret: SecretValue };
  /** Test hook: the HTTP client for the token endpoint's origin. */
  httpFor?: (laneId: LaneId, connectionId: string, baseUrl: string) => HttpClient;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Pauses between re-reads of the Vault after a failed refresh (a winner may not have stored yet). Test hook. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once Intuit has refused the refresh token and no other instance holds a newer one (T-195: records the status, notifies). Never throws. */
  onReconnectRequired?: OnReconnectRequired;
};

/** Re-reads of the Vault after a failed refresh, and the pause before each: the winner stores right after Intuit answers. */
const REREAD_DELAYS_MS = [0, 250, 500];

export interface TokenManager {
  /**
   * A usable access token for the connection. With `rejected` (the token Intuit just answered 401 for) it refreshes
   * unless the stored token has already moved on (another caller refreshed).
   */
  accessToken(laneId: LaneId, conn: LaneBoundConnection<string>, options?: { rejected?: SecretValue }): Promise<SecretValue>;
  /** The stored refresh token, for revocation at Intuit (T-195 builds the rest of disconnect). */
  refreshToken(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<SecretValue>;
}

export function parseStored(raw: SecretValue): StoredTokens {
  let parsed: z.infer<typeof StoredSchema>;
  try {
    const r = StoredSchema.safeParse(JSON.parse(raw.reveal()));
    if (!r.success) throw new Error("shape");
    parsed = r.data;
  } catch {
    // Never echo the stored text.
    throw new ConnectorError({ kind: "provider_error", message: "The stored credential is not a QuickBooks token set" });
  }
  const obtained = Date.parse(parsed.obtained_at);
  return {
    raw,
    access: new SecretValue(parsed.access_token),
    refresh: new SecretValue(parsed.refresh_token),
    // No expiry in the set: treat it as the standard hour from when it was obtained.
    accessExpiresAt: obtained + (parsed.expires_in ?? 3600) * 1000,
    refreshExpiresAt: parsed.x_refresh_token_expires_in === undefined ? null : obtained + parsed.x_refresh_token_expires_in * 1000,
  };
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const httpFor =
    deps.httpFor ??
    ((laneId: LaneId, connectionId: string, baseUrl: string) =>
      createHttpClient({
        provider: "quickbooks",
        baseUrl,
        laneId,
        connectionId,
        requestIdHeader: INTUIT_TID_HEADER,
        errorCode: (b) => (b as { error?: unknown } | null)?.error as string | undefined,
        ...(deps.logger ? { logger: deps.logger } : {}),
      }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inflight = new Map<string, Promise<StoredTokens>>();

  async function readStored(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<StoredTokens> {
    return parseStored(await deps.vault.getToken(laneId, conn));
  }

  /** The stored set when it is not `stored` any more (re-read a few times: the winner stores just after Intuit answers). */
  async function newerStored(laneId: LaneId, conn: LaneBoundConnection<string>, stored: StoredTokens): Promise<StoredTokens | null> {
    for (const delay of REREAD_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        const current = await readStored(laneId, conn);
        if (current.raw.reveal() !== stored.raw.reveal()) return current;
      } catch {
        return null; // cannot tell: report the original failure
      }
    }
    return null;
  }

  async function refresh(laneId: LaneId, conn: LaneBoundConnection<string>, stored: StoredTokens): Promise<StoredTokens> {
    const tokenUrl = new URL(await deps.tokenEndpoint(laneId));
    const { clientId, clientSecret } = deps.client();
    let data: unknown;
    try {
      const res = await httpFor(laneId, conn.id, tokenUrl.origin).request({
        method: "POST",
        path: tokenUrl.pathname,
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refresh.reveal() }),
        auth: { scheme: "Basic", secret: basicCredentials(clientId, clientSecret) },
        // Never retried: once sent, Intuit may already have rotated the token, and a repeat would be `invalid_grant`.
        retry: false,
      });
      data = res.data;
    } catch (e) {
      if (isConnectorError(e) && (e.info.provider_error_code === "invalid_grant" || e.info.kind === "timeout" || e.info.kind === "transient")) {
        // The request may have been processed, or another instance's refresh may have used our refresh token first:
        // if the stored set is no longer the one we used, someone else won and that set is the answer.
        const winner = await newerStored(laneId, conn, stored);
        if (winner) {
          log.child({ laneId, provider: "quickbooks", connectionId: conn.id }).warn("connector.token_refresh_lost_race", {});
          return winner;
        }
      }
      if (isConnectorError(e) && e.info.provider_error_code === "invalid_grant") {
        const reconnect = new ConnectorError({
          kind: "reconnect_required",
          message: "QuickBooks rejected the refresh token; the connection must be reconnected",
          http_status: e.info.http_status,
          provider_error_code: "invalid_grant",
          provider_tid: e.info.provider_tid,
          endpoint: e.info.endpoint,
        });
        await deps.onReconnectRequired?.(laneId, conn, reconnect.toJSON());
        throw reconnect;
      }
      throw e;
    }
    const parsed = TokenResponseSchema.safeParse(data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Token refresh response is not valid" });
    const t = parsed.data;
    const obtainedAt = now();
    // Only known fields are stored. Intuit may return the same refresh token again; a missing one keeps the old.
    const next = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? stored.refresh.reveal(),
      token_type: t.token_type,
      expires_in: t.expires_in,
      x_refresh_token_expires_in: typeof t.x_refresh_token_expires_in === "number" ? t.x_refresh_token_expires_in : undefined,
      obtained_at: new Date(obtainedAt).toISOString(),
    };
    const nextRaw = new SecretValue(JSON.stringify(next));
    const refreshExpiresAt = next.x_refresh_token_expires_in === undefined ? stored.refreshExpiresAt : obtainedAt + next.x_refresh_token_expires_in * 1000;
    const won = await deps.vault.rotateToken(laneId, conn, nextRaw, refreshExpiresAt === null ? null : new Date(refreshExpiresAt), stored.raw);
    const child = log.child({ laneId, provider: "quickbooks", connectionId: conn.id });
    if (won) {
      child.info("connector.token_refreshed", {});
      return parseStored(nextRaw);
    }
    // Another refresh stored its token set first: ours is discarded and the stored one is used.
    child.warn("connector.token_refresh_lost_race", {});
    return readStored(laneId, conn);
  }

  /** One read-decide-refresh, shared by every concurrent caller for the connection. */
  function flight(laneId: LaneId, conn: LaneBoundConnection<string>, rejected: string | undefined): Promise<StoredTokens> {
    const key = `${laneId}\u0000${conn.id}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const stored = await readStored(laneId, conn);
      const stale = rejected !== undefined ? stored.access.reveal() === rejected : stored.accessExpiresAt - now() <= REFRESH_SKEW_MS;
      return stale ? refresh(laneId, conn, stored) : stored;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async accessToken(laneId, conn, options) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      const rejected = options?.rejected?.reveal();
      let tokens = await flight(laneId, conn, rejected);
      // Joined a flight that started before this caller's 401 and found nothing to do: go around once more.
      if (rejected !== undefined && tokens.access.reveal() === rejected) tokens = await flight(laneId, conn, rejected);
      return tokens.access;
    },
    async refreshToken(laneId, conn) {
      assertLaneBound(laneId, conn);
      assertQuickbooksConnection(conn);
      return (await readStored(laneId, conn)).refresh;
    },
  };
}
