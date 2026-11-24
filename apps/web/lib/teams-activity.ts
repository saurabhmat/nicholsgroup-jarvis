// The Teams notice state of the SIGNED-IN person's own connection (T-289, T-290; spec 7.3, 9.4): `core.teams_activity_get` and `core.teams_activity_seen` through the person's OWN lane client
// (RLS and the SQL functions: the owner of a usable Teams connection at AAL2 with own_mail, nobody else). DATABASE ONLY: nothing here calls Microsoft or knows a chat. What comes back is
// three facts: are notices on (a live subscription), when OUR receiver last accepted one, when the person last opened the chat list. The route turns them into `{ live, liveUntil, dot,
// lastNoticeAt }`: a boolean and times, nothing about any chat (the receiver never reads a notification's `resource`, so there is nothing about a chat to tell).
import type { LaneClient } from "@nichols/core/lane-router";

type Db = Pick<LaneClient, "schema">;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
const rpc = (client: Db): Rpc => {
  const core = client.schema("core");
  return core.rpc.bind(core) as unknown as Rpc;
};

export type ActivityView = {
  /** A notice subscription of this connection is active and not expired: notices work. Without it there is no dot and the page does not ask again. */
  live: boolean;
  /** When that subscription expires (Microsoft's answer), or null. */
  liveUntil: string | null;
  /** The dot: a notice arrived (our clock) after the person last opened the chat list, and notices are on. */
  dot: boolean;
  /** Our clock: the latest accepted notice. The page refetches when this moves. */
  lastNoticeAt: string | null;
};

/** What a person without a usable Teams connection, or whose notices are off, is told: no dot, no live updates. */
export const ACTIVITY_OFF: ActivityView = Object.freeze({ live: false, liveUntil: null, dot: false, lastNoticeAt: null });

const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/** Reads the state. Throws on a database error (the route then says "unavailable": an outage is never "no activity"). */
export async function readActivity(client: Db, laneId: string, connectionId: string): Promise<ActivityView> {
  const { data, error } = await rpc(client)("teams_activity_get", { p_lane: laneId, p_connection: connectionId });
  if (error || !Array.isArray(data)) throw new Error("activity unavailable");
  const r = data[0] as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return ACTIVITY_OFF; // not the owner of a usable Teams connection (or nothing): the database returns no row
  const live = r.live === true;
  const lastNoticeAt = iso(r.last_notice_at);
  const lastSeenAt = iso(r.last_seen_at);
  const unseen = lastNoticeAt !== null && (lastSeenAt === null || lastNoticeAt > lastSeenAt);
  return { live, liveUntil: live ? iso(r.live_until) : null, dot: live && unseen, lastNoticeAt };
}

/** The person opened the chat list: `last_seen_at = now()` and the counter is reset. False when the database refused (not their usable connection). */
export async function markSeen(client: Db, laneId: string, connectionId: string): Promise<boolean> {
  const { error } = await rpc(client)("teams_activity_seen", { p_lane: laneId, p_connection: connectionId });
  return !error;
}

/** A per-person sliding-window limiter, in memory (one process; a serverless instance keeps its own: a best effort that bounds a runaway tab, not a security boundary: the endpoint reads one row). */
export function createWindowLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** Records one request for `key` and returns 0 when it is allowed, or the whole seconds to wait. */
    take(key: string): number {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((windowMs - (t - (recent[0] as number))) / 1000));
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (v.every((x) => t - x >= windowMs)) hits.delete(k);
      return 0;
    },
  };
}

/** One entry of the activity answer per usable connection (T-295, spec 22.7). */
export type AccountActivity = ActivityView & { conn: string };
export type CombinedActivity = ActivityView & { accounts: AccountActivity[] };

/**
 * The whole person's state from their usable connections' states: `live` = any live; `liveUntil` = the EARLIEST expiry among the live ones; `dot` = any dot; `lastNoticeAt` = the latest. With no
 * connection it is `ACTIVITY_OFF` with no accounts. Pure.
 */
export function combineActivity(accounts: readonly AccountActivity[]): CombinedActivity {
  if (accounts.length === 0) return { ...ACTIVITY_OFF, accounts: [] };
  const live = accounts.filter((a) => a.live);
  const liveUntils = live.map((a) => a.liveUntil).filter((t): t is string => t !== null).sort();
  const notices = accounts.map((a) => a.lastNoticeAt).filter((t): t is string => t !== null).sort();
  return {
    live: live.length > 0,
    liveUntil: liveUntils[0] ?? null,
    dot: accounts.some((a) => a.dot),
    lastNoticeAt: notices[notices.length - 1] ?? null,
    accounts: [...accounts],
  };
}
