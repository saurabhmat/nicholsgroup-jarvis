// The QuickBooks "Check connection" route's logic (T-198, now the action of the QuickBooks row in Settings -> Connections,
// T-233). Callable only for owner or admin_technical of the lane at AAL2 (the same guard as connecting). The check is one
// read-only CompanyInfo GET (rule 5); the response is a status, a time and Intuit's request id, never a token, the realm
// id or company data. The old `lane_config.pilot.connection_test_enabled` switch is no longer read (the key still parses, T-197).
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";
import type { ConnectionCheck } from "@nichols/connectors/connection-test";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

export type CheckHandlerDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  check: (laneId: string) => Promise<ConnectionCheck>;
};

/**
 * POST /api/connection-test/qbo/check?lane=PKG (same origin). 401 without a session; 403 without AAL2 or without the
 * owner / admin_technical role; 404 for a lane that is not the caller's (the same answer as an unknown lane); 200 with `{ status, checked_at, intuit_tid }`.
 */
export function createConnectionCheckHandler(deps: CheckHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden" }, 403);
    const laneId = url.searchParams.get("lane") ?? "";
    try {
      const g = await deps.guards();
      try {
        await g.requireLane(laneId);
      } catch (e) {
        // Not a member of this lane (or no such lane): indistinguishable from a lane that does not exist.
        if (e instanceof AuthError && e.reason === "forbidden") return json({ error: "not_found" }, 404);
        throw e;
      }
      await g.requireRole(laneId, CONNECT_ROLES);
      const { status, checked_at, intuit_tid } = await deps.check(laneId);
      return json({ status, checked_at, intuit_tid }, 200);
    } catch (e) {
      const res = authErrorResponse(e);
      if (res) return res;
      console.error("[api/connection-test] unavailable:", e instanceof Error ? e.name : typeof e);
      return json({ error: "unavailable" }, 503);
    }
  };
}
