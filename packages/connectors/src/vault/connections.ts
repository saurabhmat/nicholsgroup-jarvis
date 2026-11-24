// Creating connection rows (T-035). The OAuth callback learns the account (QuickBooks realm, Google mailbox) only after
// the token exchange, so it needs a row before `storeToken`. A new row starts `pending`; `storeToken` makes it active.
// An existing row for the same (lane, provider, account) is reused untouched (a reconnect), so a failed reconnect never
// downgrades an active connection. Uses the lane's job client: `connectionStore` is a restricted name (connectors only).
import type { LaneId } from "@nichols/core";
import { ACCOUNT_IN_USE_MESSAGE, ConnectorError } from "../contract/errors";
import { assertLaneBound, mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection, Provider } from "../contract/schemas";
import { CONNECTION_COLUMNS } from "./loader";
import type { JobClientFor } from "./tokens";

export interface ConnectionStore {
  /** The lane's connection for this provider account, created `pending` when there is none; minted lane-bound. */
  ensureConnection(laneId: LaneId, provider: Provider, externalAccountId: string, createdBy?: string): Promise<LaneBoundConnection>;
  /**
   * One native connection of the lane by id, for a reconnect (T-238): null when there is none for this lane, provider and id (another
   * lane's, another provider's, a Composio one, or no such row). Any status, `disconnected` included. Read-only; ids, status and the account id.
   */
  findById(laneId: LaneId, provider: Provider, connectionId: string): Promise<{ id: string; externalAccountId: string; status: string; ownerUserId: string | null } | null>;
  /** Merges boolean features into the connection row (T-232: Google `gmail_compose`), through the lane's job client. */
  setFeatures(laneId: LaneId, connection: LaneBoundConnection, features: Record<string, boolean>): Promise<void>;
  /** The addresses (lower-cased) of the lane's mail/calendar connections that are not disconnected, whoever owns them. Read-only; addresses only (T-247: the lane's own addresses, for "never reply to ourselves"). */
  listMailAccounts(laneId: LaneId): Promise<string[]>;
  /** The lane's newest connection for the provider that is not disconnected, or null. Read-only (T-198 health check). */
  findConnection(laneId: LaneId, provider: Provider): Promise<LaneBoundConnection | null>;
}

const ONE_LANE_INDEX = "connections_one_lane_per_account";
/** Providers whose connections are a person's mailbox or calendar and carry an owner (T-247). */
export const MAIL_PROVIDERS: readonly string[] = ["google", "microsoft"];
/**
 * Providers whose rows have an OWNER (T-247 mail, T-278 Teams). Used only to set `owner_user_id` at connect time. `MAIL_PROVIDERS` above stays the list of
 * mail/calendar providers (listMailAccounts and every mail reader): a Teams row is never in it.
 */
const OWNED_PROVIDERS: readonly string[] = [...MAIL_PROVIDERS, "microsoft_teams"];
const LANE_ID = /^[A-Z]{1,8}$/;

export function createConnectionStore(clientFor: JobClientFor): ConnectionStore {
  return {
    async ensureConnection(laneId, provider, externalAccountId, createdBy) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof externalAccountId !== "string" || externalAccountId.length === 0) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane and an account id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let row: unknown;
      try {
        const table = () => client.schema("core").from("connections");
        const inserted = await table().upsert(
          {
            lane_id: laneId,
            provider,
            external_account_id: externalAccountId,
            status: "pending",
            ...(createdBy ? { created_by: createdBy } : {}),
            // T-247: a mail/calendar connection belongs to the signed-in user who connected it, and never changes owner.
            ...(createdBy && OWNED_PROVIDERS.includes(provider) ? { owner_user_id: createdBy } : {}),
          },
          { onConflict: "lane_id,provider,external_account_id", ignoreDuplicates: true },
        );
        // 23514: a check refused the account id (format, or it looks like a secret). Database text is never passed on.
        // 23505 on the one-lane-per-account index (D-23): this account is connected in another lane. The index is
        // identified by its name in the error; any other unique violation stays a generic outage. (The index excludes
        // pending rows, so this insert is not expected to hit it; the refusal normally comes when the token is stored.)
        if (inserted.error?.code === "23505" && typeof inserted.error.message === "string" && inserted.error.message.includes(ONE_LANE_INDEX)) throw new ConnectorError({ kind: "forbidden", message: ACCOUNT_IN_USE_MESSAGE });
        if (inserted.error?.code === "23514") throw new ConnectorError({ kind: "invalid_input", message: "The provider account id was refused" });
        if (inserted.error) throw inserted.error;
        // A row without an owner (made before T-247) is claimed only by the user who started it (created_by) and just proved control of the account; a row that has an
        // owner is never touched (the callback refuses a different user: one mailbox, one owner).
        if (createdBy && OWNED_PROVIDERS.includes(provider)) {
          const claimed = await table()
            .update({ owner_user_id: createdBy })
            .eq("lane_id", laneId)
            .eq("provider", provider)
            .eq("external_account_id", externalAccountId)
            .eq("created_by", createdBy) // never a first-come takeover: only the user who started that row can claim it
            .is("owner_user_id", null);
          if (claimed.error) throw claimed.error;
        }
        const { data, error } = await table()
          .select(CONNECTION_COLUMNS)
          .eq("lane_id", laneId)
          .eq("provider", provider)
          .eq("external_account_id", externalAccountId)
          .maybeSingle();
        if (error) throw error;
        row = data;
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      try {
        return mintLaneBoundConnection(row as Connection);
      } catch {
        throw new ConnectorError({ kind: "provider_error", message: "Stored connection row is invalid" });
      }
    },
    async findById(laneId, provider, connectionId) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId) || typeof connectionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) {
        throw new ConnectorError({ kind: "invalid_input", message: "A lane and a connection id are required" });
      }
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      try {
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .select("id, external_account_id, status, owner_user_id")
          .eq("lane_id", laneId)
          .eq("provider", provider)
          .eq("transport", "native")
          .eq("id", connectionId)
          .maybeSingle();
        if (error) throw error;
        const row = data as { id?: unknown; external_account_id?: unknown; status?: unknown; owner_user_id?: unknown } | null;
        if (!row || typeof row.id !== "string" || typeof row.external_account_id !== "string" || typeof row.status !== "string") return null;
        return { id: row.id, externalAccountId: row.external_account_id, status: row.status, ownerUserId: typeof row.owner_user_id === "string" ? row.owner_user_id : null };
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
    },
    async setFeatures(laneId, connection, features) {
      assertLaneBound(laneId, connection);
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      try {
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .update({ features: { ...connection.features, ...features }, features_checked_at: new Date().toISOString() })
          .eq("lane_id", laneId)
          .eq("id", connection.id)
          .eq("provider", connection.provider)
          .select("id");
        if (error) throw error;
        if (!Array.isArray(data) || data.length === 0) throw new Error("no row");
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
    },
    async listMailAccounts(laneId) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      try {
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .select("external_account_id")
          .eq("lane_id", laneId)
          .neq("status", "disconnected")
          .in("provider", [...MAIL_PROVIDERS]);
        if (error) throw error;
        return (Array.isArray(data) ? data : []).flatMap((r: { external_account_id?: unknown }) => (typeof r.external_account_id === "string" ? [r.external_account_id.toLowerCase()] : []));
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
    },
    async findConnection(laneId, provider) {
      if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
      let client: Awaited<ReturnType<JobClientFor>>;
      try {
        client = await clientFor(laneId);
      } catch {
        throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for connection access" });
      }
      let row: unknown;
      try {
        const { data, error } = await client
          .schema("core")
          .from("connections")
          .select(CONNECTION_COLUMNS)
          .eq("lane_id", laneId)
          .eq("provider", provider)
          .neq("status", "disconnected")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        row = data;
      } catch {
        throw new ConnectorError({ kind: "transient", message: "Connection store unavailable" });
      }
      if (!row) return null;
      try {
        return mintLaneBoundConnection(row as Connection);
      } catch {
        throw new ConnectorError({ kind: "provider_error", message: "Stored connection row is invalid" });
      }
    },
  };
}
