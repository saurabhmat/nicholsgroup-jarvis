import "server-only";
// Lane router (T-016, architecture §5.2). The only place that creates Supabase DATA clients or reads the secret key
// (T-003 lint); packages/core/src/auth creates an auth-only client for the session and must never query data with
// it. Application code asks for a lane's client and never chooses a database itself.
// getLaneJobClient and createLaneRouter are restricted names (lint): request code gets user clients only.
//
// - getLaneClient(laneId, session): a client acting as the signed-in user (publishable key + the user's access
//   token), so RLS applies to every query. Before returning it, the router asks the database, with that same token,
//   for the lane row: RLS returns it only to a member at AAL2 of an enabled lane. No row, no client.
// - listLanes(session): the lanes the user may open, for the lane switcher (same RLS + served-list rules).
// - getLaneJobClient(laneId): the service client for jobs (bypasses RLS). Only for enabled lanes that the deployment
//   serves (ENABLED_LANES); every query must still filter lane_id.
// - getAudit(): the audit API (T-015) wired to audit.log() through the service client.
//
// Data planes: "core" is this Supabase project. The "nl" slot is defined but not configured (architecture
// "Read this first" 3): asking for an NL client fails closed.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAudit, type Audit } from "../audit/index";
import type { Database } from "../db/index";
import { getServerEnv, getSupabaseSecretKey, requireSupabasePublicEnv } from "../env/server";
import type { LaneId, LaneSummary } from "../lanes/index";

export type LaneClient = SupabaseClient<Database>;

/**
 * What the router needs from a session: the user's access token and its user id. Both must come from the VERIFIED
 * token (T-017's cookie reader uses the getClaims result); the database checks the token itself either way, and
 * core.may_resolve() refuses a userId that is not the token's subject.
 */
export type LaneSession = { userId: string; accessToken: string };

export type DataPlane = "core" | "nl";

export class LaneAccessError extends Error {
  readonly reason: "invalid_lane" | "not_served" | "not_allowed" | "data_plane_unavailable";
  constructor(reason: LaneAccessError["reason"]) {
    super(
      {
        invalid_lane: "Invalid lane id.",
        not_served: "This lane is not enabled in this deployment.",
        not_allowed: "No access to this lane.",
        data_plane_unavailable: "This lane's data plane is not configured.",
      }[reason],
    );
    this.name = "LaneAccessError";
    this.reason = reason;
  }
}

/** Builds clients. Injected in tests; the defaults use the server env. */
export type ClientFactory = {
  userClient(accessToken: string): LaneClient;
  serviceClient(): LaneClient;
  enabledLanes(): readonly string[];
};

const LANE_ID = /^[A-Z]{1,8}$/;
const NO_SESSION_STORAGE = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

let serviceSingleton: LaneClient | undefined;

const defaultClientFactory: ClientFactory = {
  userClient(accessToken) {
    const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = requireSupabasePublicEnv(getServerEnv());
    return createClient<Database>(url, key, {
      ...NO_SESSION_STORAGE,
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
  },
  serviceClient() {
    if (serviceSingleton) return serviceSingleton;
    const { NEXT_PUBLIC_SUPABASE_URL: url } = requireSupabasePublicEnv(getServerEnv());
    serviceSingleton = createClient<Database>(url, getSupabaseSecretKey(), NO_SESSION_STORAGE);
    return serviceSingleton;
  },
  enabledLanes() {
    return getServerEnv().ENABLED_LANES;
  },
};

export type LaneRouter = {
  getLaneClient(laneId: LaneId, session: LaneSession): Promise<LaneClient>;
  /** The lanes the session's user may open (member at AAL2, enabled in the registry and served here), by code. */
  listLanes(session: LaneSession): Promise<LaneSummary[]>;
  getLaneJobClient(laneId: LaneId): Promise<LaneClient>;
  getAudit(): Audit;
};

export function createLaneRouter(factory: ClientFactory = defaultClientFactory): LaneRouter {
  const served = (laneId: LaneId) => {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new LaneAccessError("invalid_lane");
    if (!factory.enabledLanes().includes(laneId)) throw new LaneAccessError("not_served");
  };

  /** The lane's row as `client` sees it; null when RLS hides it or the lane is disabled. Errors fail closed. */
  const laneRow = async (client: LaneClient, laneId: LaneId): Promise<{ data_plane: string } | null> => {
    const { data, error } = await client
      .schema("core")
      .from("lanes")
      .select("data_plane")
      .eq("code", laneId)
      .eq("enabled", true)
      .maybeSingle();
    if (error) throw new LaneAccessError("not_allowed");
    return data;
  };

  const forPlane = (plane: string, client: LaneClient): LaneClient => {
    if (plane === "core") return client;
    throw new LaneAccessError("data_plane_unavailable"); // "nl": slot defined, project not configured yet
  };

  return {
    async getLaneClient(laneId, session) {
      served(laneId);
      if (!session?.accessToken || !session.userId) throw new LaneAccessError("not_allowed");
      const client = factory.userClient(session.accessToken);
      const row = await laneRow(client, laneId);
      if (!row) throw new LaneAccessError("not_allowed");
      return forPlane(row.data_plane, client);
    },
    async listLanes(session) {
      if (!session?.accessToken || !session.userId) throw new LaneAccessError("not_allowed");
      // The user's own client: RLS on core.lanes returns only enabled lanes of which the user is a member at AAL2.
      // The deployment's served list and the data plane are applied on top, exactly as getLaneClient does, so a
      // listed lane is always one getLaneClient would open. A failed query is an outage, not an empty list.
      const { data, error } = await factory
        .userClient(session.accessToken)
        .schema("core")
        .from("lanes")
        .select("code, name, data_plane")
        .eq("enabled", true)
        .order("code");
      if (error) throw new Error("lane list unavailable");
      const served = factory.enabledLanes();
      return data
        .filter((r) => r.data_plane === "core" && served.includes(r.code))
        .map((r) => ({ laneId: r.code, name: r.name }));
    },
    async getLaneJobClient(laneId) {
      served(laneId);
      const client = factory.serviceClient();
      const row = await laneRow(client, laneId);
      if (!row) throw new LaneAccessError("not_allowed");
      return forPlane(row.data_plane, client);
    },
    getAudit() {
      return createAudit(async (row) => {
        // Generated function args are all non-null; audit.log() takes a null actor id for service/system actors.
        // The annotation fails to compile if audit.log()'s parameter names drift from AuditRow.
        type LogArgs = Database["audit"]["Functions"]["log"]["Args"];
        const checked: Record<keyof LogArgs, unknown> = row;
        const args = checked as LogArgs;
        const { error } = await factory.serviceClient().schema("audit").rpc("log", args);
        if (error) throw new Error("audit.log failed");
      });
    },
  };
}

const router = createLaneRouter();
export const getLaneClient = router.getLaneClient;
export const listLanes = router.listLanes;
export const getLaneJobClient = router.getLaneJobClient;
export const getAudit = router.getAudit;
