// Connector token access (T-033) over the T-032 database functions. `getToken`, `storeToken`, `rotateToken` and
// `revokeToken` are restricted names (lint: packages/connectors only); `createTokenVault` is internal to this folder.
// Every call is keyed by (laneId, connection) and first checks the connection was minted for that lane; the database
// checks the lane again before it touches the Vault.
// Secrets cross this boundary only as SecretValue, go to the database only as RPC (JSON body, bind parameters, never
// SQL text), and never appear in an error: database messages are replaced by fixed text.
import { createHash } from "node:crypto";
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import { assertLaneBound, type LaneBoundConnection } from "../contract/lane-bound";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import type { ConnectorErrorKind } from "../contract/schemas";
import { SecretValue } from "./secret";

export type JobClientFor = (laneId: LaneId) => Promise<LaneClient>;

export interface TokenVault {
  /** The connection's credential. Refused when the connection is disconnected or has none stored. */
  getToken(laneId: LaneId, conn: LaneBoundConnection<string>): Promise<SecretValue>;
  /**
   * Connect or reconnect: store (or replace) the credential and mark the connection active. `expiresAt` is the expiry
   * of the credential whose loss forces a reconnect (refresh token, API key), or null.
   */
  storeToken(
    laneId: LaneId,
    conn: LaneBoundConnection<string>,
    secret: SecretValue,
    expiresAt: Date | null,
    actorUserId?: string,
  ): Promise<void>;
  /**
   * Token refresh / key rotation; keeps the status. A compare-and-swap (T-050): `replaces` is the credential the caller
   * read and is replacing. Resolves true when stored; false when the stored credential is no longer `replaces`
   * (another refresh won), in which case nothing was changed and the caller re-reads with `getToken`.
   */
  rotateToken(
    laneId: LaneId,
    conn: LaneBoundConnection<string>,
    secret: SecretValue,
    expiresAt: Date | null,
    replaces: SecretValue,
  ): Promise<boolean>;
  /** Disconnect: delete the credential and mark the connection disconnected. True when a credential was deleted. */
  revokeToken(laneId: LaneId, conn: LaneBoundConnection<string>, actorUserId?: string): Promise<boolean>;
}

/** PostgREST error codes from the T-032 functions -> what the connector reports. Messages are never passed on. */
const ERRORS: Record<string, { kind: ConnectorErrorKind; message: string }> = {
  P0002: { kind: "not_found", message: "No stored credential for this connection" },
  "55000": { kind: "connection_unavailable", message: "The connection is disconnected" },
  "22023": { kind: "invalid_input", message: "The credential is empty or too long" },
  "22004": { kind: "invalid_input", message: "Lane and connection are required" },
  // 40001 (a lost compare-and-swap) is handled by rotateToken itself and never reaches this map.
  "42501": { kind: "forbidden", message: "Token access refused" },
  // The provider account is held by another lane (D-23): raised by core.connection_token_store only for a violation of
  // the index connections_one_lane_per_account. Any other 23505 (connection_secrets key, Vault secret name) is a real
  // fault and stays a generic "Token store unavailable".
  D0023: { kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE },
  "42883": { kind: "provider_error", message: "Token functions are not installed" },
};

function vaultError(error: { code?: string } | null | undefined): ConnectorError {
  const known = error?.code ? ERRORS[error.code] : undefined;
  return new ConnectorError(known ?? { kind: "transient", message: "Token store unavailable" });
}

const iso = (d: Date | null) => {
  if (d === null) return null;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new ConnectorError({ kind: "invalid_input", message: "expiresAt must be a valid Date or null" });
  }
  return d.toISOString();
};

const requireSecret = (secret: unknown): SecretValue => {
  if (!(secret instanceof SecretValue)) {
    throw new ConnectorError({ kind: "invalid_input", message: "Credentials must be passed as SecretValue" });
  }
  return secret;
};

/** A rotate lost its compare-and-swap (SQLSTATE 40001). Internal: `rotateToken` turns it into `false`. */
class ConflictSignal extends Error {
  override readonly name = "ConflictSignal";
}

/** Internal: the token vault over a job-client source (injected in tests). */
export function createTokenVault(clientFor: JobClientFor): TokenVault {
  // Generated RPC types mark every argument non-null; the SQL functions take null expiries and actors.
  type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;
  const call = async (laneId: LaneId, fn: string, args: Record<string, unknown>) => {
    let client: LaneClient;
    try {
      client = await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for token access" });
    }
    let result: Awaited<ReturnType<Rpc>>;
    try {
      const rpc = client.schema("core").rpc.bind(client.schema("core")) as unknown as Rpc;
      result = await rpc(fn, args);
    } catch {
      throw new ConnectorError({ kind: "transient", message: "Token store unavailable" });
    }
    if (result.error) {
      if (fn === "connection_token_rotate" && result.error.code === "40001") throw new ConflictSignal();
      throw vaultError(result.error);
    }
    return result.data;
  };

  return {
    async getToken(laneId, conn) {
      assertLaneBound(laneId, conn);
      const data = await call(laneId, "connection_token_read", { p_lane_id: laneId, p_connection_id: conn.id });
      if (typeof data !== "string" || data.length === 0) throw vaultError({ code: "P0002" });
      return new SecretValue(data);
    },
    async storeToken(laneId, conn, secret, expiresAt, actorUserId) {
      assertLaneBound(laneId, conn);
      const value = requireSecret(secret).reveal();
      await call(laneId, "connection_token_store", {
        p_lane_id: laneId,
        p_connection_id: conn.id,
        p_secret: value,
        p_expires_at: iso(expiresAt),
        p_actor_id: actorUserId ?? null,
      });
    },
    async rotateToken(laneId, conn, secret, expiresAt, replaces) {
      assertLaneBound(laneId, conn);
      const value = requireSecret(secret).reveal();
      // The hash names the stored text this write replaces; the database compares it under the connection's row lock.
      const expectedHash = createHash("sha256").update(requireSecret(replaces).reveal(), "utf8").digest("hex");
      try {
        await call(laneId, "connection_token_rotate", {
          p_lane_id: laneId,
          p_connection_id: conn.id,
          p_secret: value,
          p_expires_at: iso(expiresAt),
          p_expected_hash: expectedHash,
        });
      } catch (e) {
        if (e instanceof ConflictSignal) return false;
        throw e;
      }
      return true;
    },
    async revokeToken(laneId, conn, actorUserId) {
      assertLaneBound(laneId, conn);
      const data = await call(laneId, "connection_token_revoke", {
        p_lane_id: laneId,
        p_connection_id: conn.id,
        p_actor_id: actorUserId ?? null,
      });
      return data === true;
    },
  };
}
