// The database side of the webhook receiver (T-036): resolve a provider account to its lane and connection, claim an
// event once, mark the hand-off result, purge old receipts. Every call names a lane and gets that lane's client from the
// job-client source (the lane router, wired in vault/index.ts). The functions behind it are SECURITY DEFINER and
// service_role only (core.webhook_*). Errors carry no detail: a failure is a failure, never a hint about another lane.
import type { LaneId } from "@nichols/core";
import type { JobClientFor } from "../vault/tokens";

export type ResolveResult =
  | { kind: "found"; laneId: LaneId; connectionId: string }
  | { kind: "unknown" }
  /** More than one lane claims the account (D-23 should prevent it; across separate lane databases it cannot be enforced). Treated as unknown. */
  | { kind: "ambiguous" };

export type ClaimResult = "process" | "duplicate" | "conflict";

export interface WebhookStore {
  /**
   * Which lane and connection own this provider account. Asks every served lane in turn with the D-23 predicate
   * (lower-case account, status not disconnected/pending). The payload's own claims about lanes are never used.
   */
  resolve(provider: string, accountId: string): Promise<ResolveResult>;
  claim(laneId: LaneId, connectionId: string, provider: string, event: { id: string; type: string; payloadHash: string }): Promise<ClaimResult>;
  /** received -> enqueued | failed. Returns whether a row changed. */
  mark(laneId: LaneId, provider: string, eventId: string, status: "enqueued" | "failed"): Promise<boolean>;
  /** Retention (T-042 calls this per lane). Keeps at least 7 days; the database refuses less. */
  purge(laneId: LaneId, keepDays?: number): Promise<number>;
}

/** A store call failed (database down, lane unavailable, refusal). The message is fixed; the cause is dropped. */
export class WebhookStoreError extends Error {
  override readonly name = "WebhookStoreError";
  constructor() {
    super("webhook store unavailable");
  }
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string } | null }>;

export function createWebhookStore(clientFor: JobClientFor, lanes: () => readonly LaneId[]): WebhookStore {
  const call = async (laneId: LaneId, fn: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const client = await clientFor(laneId);
      const core = client.schema("core");
      const { data, error } = await (core.rpc.bind(core) as unknown as Rpc)(fn, args);
      if (error) throw new WebhookStoreError();
      return data;
    } catch {
      throw new WebhookStoreError();
    }
  };

  return {
    async resolve(provider, accountId) {
      const served = [...new Set(lanes())];
      const found = await Promise.all(
        served.map(async (laneId) => {
          const id = await call(laneId, "webhook_resolve_connection", { p_lane: laneId, p_provider: provider, p_account: accountId });
          return typeof id === "string" ? { laneId, connectionId: id } : null;
        }),
      );
      const hits = found.filter((f): f is { laneId: LaneId; connectionId: string } => f !== null);
      const [hit] = hits;
      if (!hit) return { kind: "unknown" };
      if (hits.length > 1) return { kind: "ambiguous" };
      return { kind: "found", ...hit };
    },
    async claim(laneId, connectionId, provider, event) {
      const data = await call(laneId, "webhook_event_claim", {
        p_lane: laneId,
        p_connection_id: connectionId,
        p_provider: provider,
        p_event_id: event.id,
        p_event_type: event.type,
        p_payload_hash: event.payloadHash,
      });
      if (data === "process" || data === "duplicate" || data === "conflict") return data;
      throw new WebhookStoreError();
    },
    async mark(laneId, provider, eventId, status) {
      const data = await call(laneId, "webhook_event_mark", { p_lane: laneId, p_provider: provider, p_event_id: eventId, p_status: status });
      return data === true;
    },
    async purge(laneId, keepDays = 30) {
      const data = await call(laneId, "webhook_events_purge", { p_lane: laneId, p_keep: `${Math.trunc(keepDays)} days` });
      return typeof data === "number" ? data : 0;
    },
  };
}
