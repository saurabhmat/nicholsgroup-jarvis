// Microsoft access tokens (T-256, spec §7 "Tokens"). The Vault holds one JSON token set per connection (access + refresh token).
// This module hands out a usable access token: refreshed when it has less than REFRESH_SKEW_MS left, and on demand when Graph
// answered 401 for the one we used. It accepts only a connection the guard approved (`GuardedMicrosoftConnection`), so a token is
// never read for a call that was not checked.
//
// Microsoft rotates refresh tokens on use (V-8, docs/plan-review.md): a refresh returns a new one that must replace the stored one,
// and the old one is NOT revoked by use. So (same design as QuickBooks):
//  - refreshes for one connection are single-flight within a process;
//  - across processes the new set is stored with `rotateToken`, a compare-and-swap on the exact stored text: the loser discards its
//    own result and re-reads the winner's. A lost race is harmless because the old refresh token still works;
//  - the new set replaces the old one in the same step (one Vault secret per connection): the old refresh token is never kept.
// The refresh POST is never retried. When it times out or Microsoft refuses it, the Vault is re-read first: a changed store means
// another instance won and its set is used. Only an unchanged store with an OAuth `error` of `invalid_grant`, `interaction_required`
// or `consent_required` (revoked, expired through inactivity, password changed, consent withdrawn, conditional access: V-7) is
// `reconnect_required`. The OAuth `error` string decides; AADSTS codes are not consulted. `invalid_client` (our own client id or
// secret is wrong) and 5xx are NOT a dead grant and leave as the HTTP client raised them.
// Tokens, the client secret and the stored text never appear in logs or errors: values are SecretValues, messages are fixed.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound } from "../contract/lane-bound";
import type { HttpClient } from "../http/client";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { TokenResponseSchema } from "../oauth/flow";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { isCloudSupported, loginOriginFor, REFRESH_SKEW_MS, TOKEN_PATH } from "./constants";
import { isGuarded, type GuardedMicrosoftConnection } from "./guard";
import { createGraphHttp, type GraphHttpFor } from "./http";
import type { OnReconnectRequired } from "../quickbooks/reconnect";

const StoredSchema = z.looseObject({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().positive().optional(),
  obtained_at: z.iso.datetime({ offset: true }),
});

/** A token set as stored, parsed. `raw` is the exact stored text (the compare-and-swap names it). */
export type StoredTokens = { raw: SecretValue; access: SecretValue; refresh: SecretValue; accessExpiresAt: number };

export type MicrosoftTokenManagerDeps = {
  vault: Pick<TokenVault, "getToken" | "rotateToken">;
  client: () => { clientId: string; clientSecret: SecretValue };
  /** Test hook: the HTTP client for the token host. The default is `createGraphHttp(.., "token")`, which enforces the host allow-list. */
  httpFor?: GraphHttpFor;
  now?: () => number;
  logger?: ConnectorLogger;
  /** Pauses between re-reads of the Vault after a failed refresh. Test hook. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once Microsoft refused the refresh token and no other instance holds a newer one (records the status, notifies). Never throws. */
  onReconnectRequired?: OnReconnectRequired;
};

export interface MicrosoftTokenManager {
  /** A usable access token. With `rejected` (the token Graph just answered 401 for) it refreshes unless already replaced. */
  accessToken(laneId: LaneId, guarded: GuardedMicrosoftConnection, options?: { rejected?: SecretValue }): Promise<SecretValue>;
}

/** OAuth `error` strings that mean the grant needs a person (V-7). */
export const RECONNECT_ERRORS: ReadonlySet<string> = new Set(["invalid_grant", "interaction_required", "consent_required"]);

export function parseStored(raw: SecretValue): StoredTokens {
  let parsed: z.infer<typeof StoredSchema>;
  try {
    const r = StoredSchema.safeParse(JSON.parse(raw.reveal()));
    if (!r.success) throw new Error("shape");
    parsed = r.data;
  } catch {
    // Never echo the stored text.
    throw new ConnectorError({ kind: "provider_error", message: "The stored credential is not a Microsoft token set" });
  }
  return {
    raw,
    access: new SecretValue(parsed.access_token),
    refresh: new SecretValue(parsed.refresh_token),
    // No expiry in the set: treat it as an hour from when it was obtained. (A refresh token's own expiry is not returned: V-8.)
    accessExpiresAt: Date.parse(parsed.obtained_at) + (parsed.expires_in ?? 3600) * 1000,
  };
}

const REREAD_DELAYS_MS = [0, 250, 500];

export function createMicrosoftTokenManager(deps: MicrosoftTokenManagerDeps): MicrosoftTokenManager {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inflight = new Map<string, Promise<StoredTokens>>();

  const readStored = async (laneId: LaneId, g: GuardedMicrosoftConnection) => parseStored(await deps.vault.getToken(laneId, g.conn));

  /** The stored set when it is not `stored` any more (re-read a few times: the winner stores just after Microsoft answers). */
  async function newerStored(laneId: LaneId, g: GuardedMicrosoftConnection, stored: StoredTokens): Promise<StoredTokens | null> {
    for (const delay of REREAD_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      let current: StoredTokens;
      try {
        current = await readStored(laneId, g);
      } catch {
        // We cannot tell whether another instance won: that is an outage, never "unchanged", so never reconnect_required.
        throw new ConnectorError({ kind: "transient", message: "The stored credential could not be re-read after a failed refresh" });
      }
      if (current.raw.reveal() !== stored.raw.reveal()) return current;
    }
    return null;
  }

  async function refresh(laneId: LaneId, g: GuardedMicrosoftConnection, stored: StoredTokens): Promise<StoredTokens> {
    if (!isCloudSupported(g.cloud)) throw new ConnectorError({ kind: "unsupported_op", message: "This Microsoft cloud is not supported yet" });
    const { clientId, clientSecret } = deps.client();
    const baseUrl = loginOriginFor(g.cloud);
    const http: HttpClient = deps.httpFor ? deps.httpFor(laneId, g.conn.id, baseUrl) : createGraphHttp({ baseUrl, laneId, connectionId: g.conn.id, ...(deps.logger ? { logger: deps.logger } : {}) }, g.cloud, "token");
    const child = log.child({ laneId, provider: "microsoft", connectionId: g.conn.id });
    let data: unknown;
    try {
      const res = await http.request({
        method: "POST",
        path: TOKEN_PATH,
        params: { tenant: g.tenantId },
        // The client secret rides in the body (Microsoft web-app flow); the HTTP client never logs a body.
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refresh.reveal(), client_id: clientId, client_secret: clientSecret.reveal() }),
        // Never retried: once sent, Microsoft may already have rotated the token.
        retry: false,
      });
      data = res.data;
    } catch (e) {
      const code = isConnectorError(e) ? e.info.provider_error_code : null;
      const dead = code !== null && RECONNECT_ERRORS.has(code);
      if (isConnectorError(e) && (dead || e.info.kind === "timeout" || e.info.kind === "transient")) {
        // Another instance may have refreshed first: if the stored set is no longer the one we used, its set is the answer.
        const winner = await newerStored(laneId, g, stored);
        if (winner) {
          child.warn("connector.token_refresh_lost_race", {});
          return winner;
        }
      }
      if (isConnectorError(e) && dead) {
        const reconnect = new ConnectorError({
          kind: "reconnect_required",
          message: "Microsoft rejected the refresh token; the connection must be reconnected",
          http_status: e.info.http_status,
          provider_error_code: code,
          provider_tid: e.info.provider_tid,
          endpoint: e.info.endpoint,
        });
        await deps.onReconnectRequired?.(laneId, g.conn, reconnect.toJSON());
        throw reconnect;
      }
      throw e;
    }
    const parsed = TokenResponseSchema.safeParse(data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Token refresh response is not valid" });
    const t = parsed.data;
    // Only known fields are stored. The new refresh token REPLACES the old one (V-8); a response without one keeps the old (still valid).
    const next = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? stored.refresh.reveal(),
      token_type: t.token_type,
      expires_in: t.expires_in,
      scope: t.scope,
      obtained_at: new Date(now()).toISOString(),
    };
    const nextRaw = new SecretValue(JSON.stringify(next));
    // token_expires_at stays null: a refresh token's lifetime is sliding and not returned (V-8); expiry is found by the refresh failing.
    const won = await deps.vault.rotateToken(laneId, g.conn, nextRaw, null, stored.raw);
    if (won) {
      child.info("connector.token_refreshed", {});
      return parseStored(nextRaw);
    }
    // Another refresh stored its set first: ours is discarded and the stored one is used.
    child.warn("connector.token_refresh_lost_race", {});
    return readStored(laneId, g);
  }

  /** One read-decide-refresh, shared by every concurrent caller for the connection. */
  function flight(laneId: LaneId, g: GuardedMicrosoftConnection, rejected: string | undefined): Promise<StoredTokens> {
    const key = `${laneId}\u0000${g.conn.id}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const stored = await readStored(laneId, g);
      const stale = rejected !== undefined ? stored.access.reveal() === rejected : stored.accessExpiresAt - now() <= REFRESH_SKEW_MS;
      return stale ? refresh(laneId, g, stored) : stored;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async accessToken(laneId, guarded, options) {
      if (!isGuarded(guarded)) throw new ConnectorError({ kind: "forbidden", message: "The connection was not approved by the Microsoft guard" });
      assertLaneBound(laneId, guarded.conn);
      const rejected = options?.rejected?.reveal();
      let tokens = await flight(laneId, guarded, rejected);
      // Joined a flight that started before this caller's 401 and found nothing to do: go around once more.
      if (rejected !== undefined && tokens.access.reveal() === rejected) tokens = await flight(laneId, guarded, rejected);
      return tokens.access;
    },
  };
}
