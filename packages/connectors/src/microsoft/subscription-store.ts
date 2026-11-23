// The database side of Microsoft change-notification subscriptions (T-068, T-264): core.push_subscriptions through the lane's job client (the lane router, wired in
// vault/index.ts), only via the security-definer functions core.push_subscription_* (service_role only). Every call names a lane and, where it acts on a row, the connection:
// the SQL checks both, so renew, mark and stop can only touch a subscription recorded for that (lane, connection). The clientState is a Vault secret held by the database: it
// comes back only from `lookupMany` (for the receiver's constant-time comparison) and goes in only through `record`, always as a SecretValue / bind parameter, never in a log or an error.
// Errors carry fixed text: a failure is a failure, never a hint about another lane.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { SecretValue } from "../vault/secret";
import type { JobClientFor } from "../vault/tokens";
import { SUBSCRIPTION_RESOURCES, type SubscriptionResource } from "./constants";
import { TEAMS_SUBSCRIPTION_RESOURCE } from "../teams/constants";

/** The stream a subscription watches: a mailbox's inbox or calendar (provider `microsoft`), or a Teams connection's chats (provider `microsoft_teams`, T-289). */
export type StoredResource = SubscriptionResource | typeof TEAMS_SUBSCRIPTION_RESOURCE;
export type StoredSubscriptionStatus = "active" | "reauthorization_required";
export type StoredSubscription = { resource: StoredResource; subscriptionId: string; status: StoredSubscriptionStatus; expiresAt: Date };

export type RecordSubscription = {
  connectionId: string;
  resource: SubscriptionResource;
  subscriptionId: string;
  expiresAt: Date;
  clientState: SecretValue;
};
/** The Teams form (T-289): the provider and the resource path are the Teams ones; the SQL checks tie `teams_chats` to `microsoft_teams`, and the path to one person's all chats. */
export type RecordTeamsSubscription = {
  connectionId: string;
  resource: typeof TEAMS_SUBSCRIPTION_RESOURCE;
  /** `users/<entra object id>/chats/getAllMessages`: never an address, never the clientState. */
  resourcePath: string;
  subscriptionId: string;
  expiresAt: Date;
  clientState: SecretValue;
};

/** What the receiver learns about a notification's subscription: the lane and connection come from the stored row, never from the request. */
export type SubscriptionLookup = {
  laneId: LaneId;
  connectionId: string;
  resource: StoredResource;
  status: StoredSubscriptionStatus;
  clientState: SecretValue;
};

export interface MicrosoftSubscriptionStore {
  /** The live (not removed) subscriptions recorded for exactly this (lane, connection). */
  list(laneId: LaneId, connectionId: string): Promise<StoredSubscription[]>;
  /** Records a subscription Graph just created (a usable Microsoft connection of this lane); supersedes the live row of the same stream. */
  record(laneId: LaneId, input: RecordSubscription | RecordTeamsSubscription): Promise<void>;
  /** Moves a live subscription's expiry (and clears reauthorization_required). False when no live row of this (lane, connection) has that id. */
  renewed(laneId: LaneId, connectionId: string, subscriptionId: string, expiresAt: Date): Promise<boolean>;
  /** `reauthorization_required` or `removed` (deleting the Vault secret). False when no live row of this (lane, connection) has that id. */
  mark(laneId: LaneId, connectionId: string, subscriptionId: string, status: "reauthorization_required" | "removed"): Promise<boolean>;
  /** Marks every live subscription of the connection removed (disconnect, provider switched off). Returns how many. */
  removeConnection(laneId: LaneId, connectionId: string): Promise<number>;
  /**
   * The live subscriptions of this lane among these provider ids (at most 200, distinct), for usable connections: one database call per Microsoft provider (the mail and calendar ones, and
   * the Teams ones, T-289), asked together; ids that are unknown, removed, of another lane or of a disconnected connection are absent from the map.
   */
  lookupMany(laneId: LaneId, subscriptionIds: readonly string[]): Promise<Map<string, SubscriptionLookup>>;
  /** Retention (T-042 calls this per lane): deletes rows removed more than 30 days ago (fixed in SQL). */
  purge(laneId: LaneId): Promise<number>;
}

const PROVIDER = "microsoft";
const TEAMS_PROVIDER = "microsoft_teams";
/** The receiver asks for both: a notification does not say which kind of connection it is for. */
const LOOKUP_PROVIDERS = [PROVIDER, TEAMS_PROVIDER] as const;
const resourceByName = new Map<string, StoredResource>([["mail", "mail"], ["calendar", "calendar"], [TEAMS_SUBSCRIPTION_RESOURCE, TEAMS_SUBSCRIPTION_RESOURCE]]);

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

const unavailable = () => new ConnectorError({ kind: "transient", message: "Subscription store unavailable" });

export function createMicrosoftSubscriptionStore(clientFor: JobClientFor): MicrosoftSubscriptionStore {
  const call = async (laneId: LaneId, fn: string, args: Record<string, unknown>): Promise<unknown> => {
    let result: Awaited<ReturnType<Rpc>>;
    try {
      const client = await clientFor(laneId);
      const core = client.schema("core");
      result = await (core.rpc.bind(core) as unknown as Rpc)(fn, args);
    } catch {
      throw unavailable();
    }
    if (result.error) {
      // 42501: the connection is not a usable Microsoft connection of this lane (or the lane is off): the same answer for every cause.
      if (result.error.code === "42501") throw new ConnectorError({ kind: "connection_unavailable", message: "The connection is not available for subscriptions" });
      throw unavailable();
    }
    return result.data;
  };
  const rows = (data: unknown): Record<string, unknown>[] => (Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null) : []);
  const status = (v: unknown): StoredSubscriptionStatus | null => (v === "active" || v === "reauthorization_required" ? v : null);

  return {
    async list(laneId, connectionId) {
      const out: StoredSubscription[] = [];
      for (const r of rows(await call(laneId, "push_subscription_list", { p_lane: laneId, p_connection_id: connectionId }))) {
        const resource = typeof r.resource === "string" ? resourceByName.get(r.resource) : undefined;
        const st = status(r.status);
        const at = typeof r.expires_at === "string" ? Date.parse(r.expires_at) : Number.NaN;
        if (resource && st && typeof r.subscription_id === "string" && !Number.isNaN(at)) out.push({ resource, subscriptionId: r.subscription_id, status: st, expiresAt: new Date(at) });
      }
      return out;
    },
    async record(laneId, input) {
      const teams = input.resource === TEAMS_SUBSCRIPTION_RESOURCE;
      await call(laneId, "push_subscription_record", {
        p_lane: laneId,
        p_connection_id: input.connectionId,
        p_provider: teams ? TEAMS_PROVIDER : PROVIDER,
        p_resource: input.resource,
        p_subscription_id: input.subscriptionId,
        p_resource_path: "resourcePath" in input ? input.resourcePath : SUBSCRIPTION_RESOURCES[input.resource],
        p_expires_at: input.expiresAt.toISOString(),
        p_client_state: input.clientState.reveal(),
      });
    },
    async renewed(laneId, connectionId, subscriptionId, expiresAt) {
      return (await call(laneId, "push_subscription_renewed", { p_lane: laneId, p_connection_id: connectionId, p_subscription_id: subscriptionId, p_expires_at: expiresAt.toISOString() })) === true;
    },
    async mark(laneId, connectionId, subscriptionId, to) {
      return (await call(laneId, "push_subscription_mark", { p_lane: laneId, p_connection_id: connectionId, p_subscription_id: subscriptionId, p_status: to })) === true;
    },
    async removeConnection(laneId, connectionId) {
      const n = await call(laneId, "push_subscriptions_remove_connection", { p_lane: laneId, p_connection_id: connectionId });
      return typeof n === "number" ? n : 0;
    },
    async lookupMany(laneId, subscriptionIds) {
      const out = new Map<string, SubscriptionLookup>();
      if (subscriptionIds.length === 0) return out;
      // one call per provider, together (a Teams subscription is recorded under `microsoft_teams`, a mail one under `microsoft`; an id is unique to one of them)
      const answers = await Promise.all(LOOKUP_PROVIDERS.map((provider) => call(laneId, "push_subscription_lookup", { p_lane: laneId, p_provider: provider, p_subscription_ids: [...subscriptionIds] })));
      for (const r of answers.flatMap((a) => rows(a))) {
        const resource = typeof r.resource === "string" ? resourceByName.get(r.resource) : undefined;
        const st = status(r.status);
        if (!resource || !st || typeof r.subscription_id !== "string" || typeof r.connection_id !== "string" || typeof r.client_state !== "string" || r.client_state.length === 0) continue;
        out.set(r.subscription_id, { laneId, connectionId: r.connection_id, resource, status: st, clientState: new SecretValue(r.client_state) });
      }
      return out;
    },
    async purge(laneId) {
      const n = await call(laneId, "push_subscriptions_purge", { p_lane: laneId });
      return typeof n === "number" ? n : 0;
    },
  };
}
