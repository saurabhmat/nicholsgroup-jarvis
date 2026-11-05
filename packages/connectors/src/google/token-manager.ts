// Google access tokens (T-063). The Vault holds one JSON token set per connection (access + refresh token). This module
// hands out a usable access token: refreshed when it has less than REFRESH_SKEW_MS left, and on demand when Google
// answered 401 for the one we used.
//
// Google does not rotate refresh tokens, but two instances may still refresh at once, so:
//  - refreshes for one connection are single-flight within a process;
//  - the new set is stored with `rotateToken`, a compare-and-swap on the exact stored text: the loser keeps the winner's;
//  - `invalid_grant` (revoked, expired, or the user removed the app) first re-reads the Vault (another instance may have
//    stored a newer set), and only an unchanged store means `reconnect_required`. Recording that status is T-195.
// The refresh POST is not retried: a lost response is settled by the next sync, not by guessing.
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError, isConnectorError } from "../contract/errors";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { connectorLog, type ConnectorLogger } from "../log/index";
import { TokenResponseSchema } from "../oauth/flow";
import { SecretValue } from "../vault/secret";
import type { TokenVault } from "../vault/tokens";
import { GOOGLE_TOKEN_URL, REFRESH_SKEW_MS } from "./constants";
import { assertGoogleConnection } from "./guard";
import { createGoogleHttp, type GoogleHttpFor } from "./http";

const StoredSchema = z.looseObject({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192),
  expires_in: z.number().positive().optional(),
  obtained_at: z.iso.datetime({ offset: true }),
});

export type StoredTokens = { raw: SecretValue; access: SecretValue; refresh: SecretValue; accessExpiresAt: number };

export type GoogleTokenManagerDeps = {
  vault: Pick<TokenVault, "getToken" | "rotateToken">;
  client: () => { clientId: string; clientSecret: SecretValue };
  httpFor?: GoogleHttpFor;
  now?: () => number;
  logger?: ConnectorLogger;
  sleep?: (ms: number) => Promise<void>;
};

export interface GoogleTokenManager {
  /** A usable access token. With `rejected` (the token Google just answered 401 for) it refreshes unless already replaced. */
  accessToken(laneId: LaneId, conn: LaneBoundConnection<string>, options?: { rejected?: SecretValue }): Promise<SecretValue>;
  /** The stored refresh token, for revocation at Google (approvals-only writer). */
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
    throw new ConnectorError({ kind: "provider_error", message: "The stored credential is not a Google token set" });
  }
  return {
    raw,
    access: new SecretValue(parsed.access_token),
    refresh: new SecretValue(parsed.refresh_token),
    accessExpiresAt: Date.parse(parsed.obtained_at) + (parsed.expires_in ?? 3600) * 1000,
  };
}

const REREAD_DELAYS_MS = [0, 250];

export function createGoogleTokenManager(deps: GoogleTokenManagerDeps): GoogleTokenManager {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? connectorLog;
  const httpFor: GoogleHttpFor =
    deps.httpFor ??
    ((laneId, connectionId, baseUrl) => createGoogleHttp({ baseUrl, laneId, ...(connectionId ? { connectionId } : {}), ...(deps.logger ? { logger: deps.logger } : {}) }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inflight = new Map<string, Promise<StoredTokens>>();

  const readStored = async (laneId: LaneId, conn: LaneBoundConnection<string>) => parseStored(await deps.vault.getToken(laneId, conn));

  async function newerStored(laneId: LaneId, conn: LaneBoundConnection<string>, stored: StoredTokens): Promise<StoredTokens | null> {
    for (const delay of REREAD_DELAYS_MS) {
      if (delay > 0) await sleep(delay);
      try {
        const current = await readStored(laneId, conn);
        if (current.raw.reveal() !== stored.raw.reveal()) return current;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function refresh(laneId: LaneId, conn: LaneBoundConnection<string>, stored: StoredTokens): Promise<StoredTokens> {
    const token = new URL(GOOGLE_TOKEN_URL);
    const { clientId, clientSecret } = deps.client();
    let data: unknown;
    try {
      const res = await httpFor(laneId, conn.id, token.origin).request({
        method: "POST",
        path: token.pathname,
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refresh.reveal(), client_id: clientId, client_secret: clientSecret.reveal() }),
        retry: false,
      });
      data = res.data;
    } catch (e) {
      if (isConnectorError(e) && (e.info.provider_error_code === "invalid_grant" || e.info.kind === "timeout" || e.info.kind === "transient")) {
        const winner = await newerStored(laneId, conn, stored);
        if (winner) return winner;
      }
      if (isConnectorError(e) && e.info.provider_error_code === "invalid_grant") {
        throw new ConnectorError({
          kind: "reconnect_required",
          message: "Google rejected the refresh token; the connection must be reconnected",
          http_status: e.info.http_status,
          provider_error_code: "invalid_grant",
          endpoint: e.info.endpoint,
        });
      }
      throw e;
    }
    const parsed = TokenResponseSchema.safeParse(data);
    if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "Token refresh response is not valid" });
    const t = parsed.data;
    const next = {
      access_token: t.access_token,
      refresh_token: t.refresh_token ?? stored.refresh.reveal(), // Google normally sends none: the old one stays valid
      token_type: t.token_type,
      expires_in: t.expires_in,
      scope: t.scope,
      obtained_at: new Date(now()).toISOString(),
    };
    const nextRaw = new SecretValue(JSON.stringify(next));
    const won = await deps.vault.rotateToken(laneId, conn, nextRaw, null, stored.raw);
    const child = log.child({ laneId, provider: "google", connectionId: conn.id });
    if (won) {
      child.info("connector.token_refreshed", {});
      return parseStored(nextRaw);
    }
    child.warn("connector.token_refresh_lost_race", {});
    return readStored(laneId, conn);
  }

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
      assertGoogleConnection(conn);
      const rejected = options?.rejected?.reveal();
      let tokens = await flight(laneId, conn, rejected);
      if (rejected !== undefined && tokens.access.reveal() === rejected) tokens = await flight(laneId, conn, rejected);
      return tokens.access;
    },
    async refreshToken(laneId, conn) {
      assertLaneBound(laneId, conn);
      assertGoogleConnection(conn);
      return (await readStored(laneId, conn)).refresh;
    },
  };
}
