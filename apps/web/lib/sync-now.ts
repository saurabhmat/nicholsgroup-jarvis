// "Sync now" (T-238 part B): POST /api/lanes/PKG/sync-now asks conn.sync to run every usable Google connection of the lane now
// (trigger "manual", both streams), instead of waiting for the next 15-minute tick.
//  - Who: owner or admin_technical of the lane at AAL2 (the same guard as connecting). No session 401; AAL1 or another role 403; a
//    lane that is not the caller's (or no such lane) 404, the same answer as an unknown lane.
//  - Cross-site: the request must carry Origin = this site (a form or fetch from the page); Sec-Fetch-Site other than same-origin is 403.
//  - Rate limit: one per lane per 2 minutes, in the database (core.sync_now_claim: atomic, per lane, whoever clicks). Refused with 429 and
//    retryAfterSeconds. A lane with no usable Google connection answers `no_connections` WITHOUT using up the limit.
//  - Events: one conn/sync.requested per connection (ids only), event id `sync-now:<connectionId>:<2-minute slot>` as a second dedupe.
//  - Audit: `connection.sync_now` with who, lane and the number of connections (ids and counts only), written BEFORE any event is sent;
//    if the audit write fails nothing is sent (503).
// The connection list comes from the lane router (connectors); events go through sendLaneEvent (validated, lane must be served).
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import type { Audit } from "@nichols/core/audit";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

export const SYNC_NOW_SLOT_MS = 2 * 60_000;
export const syncNowEventId = (connectionId: string, nowMs: number): string => `sync-now:${connectionId}:${String(Math.floor(nowMs / SYNC_NOW_SLOT_MS))}`;

export type SyncNowResult =
  | { status: "started"; connections: number }
  | { status: "no_connections"; connections: 0 };

type Rpc = { schema(s: "core"): { rpc(fn: "sync_now_claim", args: { p_lane: string }): PromiseLike<{ data: unknown; error: { code?: string } | null }> } };

export type SyncNowDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  audit: () => Audit;
  /** Usable Google connection ids of the lane (the lane router's lister; ids only). */
  listConnections: (laneId: string) => Promise<readonly string[]>;
  /** conn/sync.requested for one connection (trigger manual, both streams). Throws when it could not be sent. */
  send: (laneId: string, connectionId: string, eventId: string) => Promise<unknown>;
  now?: () => Date;
};

const LANE = /^[A-Z]{1,8}$/;

export function createSyncNowHandler(deps: SyncNowDeps) {
  return async function POST(request: Request, laneId: string): Promise<Response> {
    const url = new URL(request.url);
    const site = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== url.origin || (site !== null && site !== "same-origin")) return json({ error: "forbidden" }, 403);
    if (!LANE.test(laneId)) return json({ error: "not_found" }, 404);
    try {
      const g = await deps.guards();
      try {
        await g.requireLane(laneId);
      } catch (e) {
        if (e instanceof AuthError && e.reason === "forbidden") return json({ error: "not_found" }, 404);
        throw e;
      }
      const { session, client } = await g.requireRole(laneId, CONNECT_ROLES);

      const ids = [...new Set(await deps.listConnections(laneId))];
      if (ids.length === 0) return json({ status: "no_connections", connections: 0 } satisfies SyncNowResult, 200);

      const claim = await (client as unknown as Rpc).schema("core").rpc("sync_now_claim", { p_lane: laneId });
      if (claim.error) {
        if (claim.error.code === "42501") return json({ error: "forbidden" }, 403);
        throw new Error("rate limit unavailable");
      }
      const res = claim.data as { ok?: unknown; retry_after_seconds?: unknown } | null;
      if (res?.ok !== true) {
        const wait = typeof res?.retry_after_seconds === "number" && res.retry_after_seconds > 0 ? Math.min(Math.ceil(res.retry_after_seconds), 120) : 120;
        return Response.json({ error: "rate_limited", retryAfterSeconds: wait }, { status: 429, headers: { ...NO_STORE, "retry-after": String(wait) } });
      }

      // Audit first: a sync nobody can see in the log never starts. Ids and a count only.
      await deps.audit().log({
        laneId: laneId as never,
        actor: { kind: "user", userId: session.userId },
        action: "connection.sync_now",
        target: `lane:${laneId}`,
        metadata: { connections: ids.length },
      });

      const nowMs = (deps.now ?? (() => new Date()))().getTime();
      const sent = await Promise.allSettled(ids.map((id) => deps.send(laneId, id, syncNowEventId(id, nowMs))));
      const started = sent.filter((r) => r.status === "fulfilled").length;
      if (started === 0) return json({ error: "jobs_unavailable" }, 503);
      return json({ status: "started", connections: started } satisfies SyncNowResult, 200);
    } catch (e) {
      const res = authErrorResponse(e);
      if (res) return res;
      console.error("[api/sync-now] unavailable:", e instanceof Error ? e.name : typeof e);
      return json({ error: "unavailable" }, 503);
    }
  };
}
