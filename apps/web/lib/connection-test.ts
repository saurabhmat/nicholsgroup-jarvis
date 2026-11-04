// The temporary QuickBooks connection test (T-198): who may see it, whether it is switched on, and the check route's
// logic. Visible and callable only for owner or admin_technical of the lane at AAL2 (the same guard as connecting), and
// only when `lane_config.pilot.connection_test_enabled` is true. The check is one read-only CompanyInfo GET (rule 5); the
// response is a status, a time and Intuit's request id, never a token, the realm id or company data.
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import { CONNECT_ROLES } from "@nichols/connectors/oauth";
import type { ConnectionCheck } from "@nichols/connectors/connection-test";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });

/** Exactly `true` at `config.pilot.connection_test_enabled`; anything else (missing, "true", 1) is off. */
function flagOn(config: unknown): boolean {
  if (typeof config !== "object" || config === null) return false;
  const pilot = (config as { pilot?: unknown }).pilot;
  return typeof pilot === "object" && pilot !== null && (pilot as { connection_test_enabled?: unknown }).connection_test_enabled === true;
}

/** The lane's switch, read with the signed-in user's own lane client (owner and admin_technical may read the config). Fails closed. */
export async function connectionTestEnabled(client: Pick<LaneClient, "schema">, laneId: string): Promise<boolean> {
  const { data, error } = await client.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
  if (error) return false;
  return flagOn(data?.config);
}

type RoleGuards = Pick<Guards, "requireRole">;

/** Settings page: show the section only to an owner or admin_technical at AAL2, and only when the lane switched it on. */
export async function connectionTestVisible(g: RoleGuards, laneId: string, enabled = connectionTestEnabled): Promise<boolean> {
  try {
    const { client } = await g.requireRole(laneId, CONNECT_ROLES);
    return await enabled(client, laneId);
  } catch (e) {
    if (e instanceof AuthError) return false; // a viewer, AAL1 or a lane that is not theirs just does not see it
    throw e;
  }
}

export type CheckHandlerDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  enabled?: (client: Pick<LaneClient, "schema">, laneId: string) => Promise<boolean>;
  check: (laneId: string) => Promise<ConnectionCheck>;
};

/**
 * POST /api/connection-test/qbo/check?lane=PKG (same origin). 401 without a session; 403 without AAL2 or without the
 * owner / admin_technical role; 404 for a lane that is not the caller's (the same answer as an unknown lane) and when the
 * test is switched off; 200 with `{ status, checked_at, intuit_tid }`.
 */
export function createConnectionCheckHandler(deps: CheckHandlerDeps) {
  const enabled = deps.enabled ?? connectionTestEnabled;
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
      const { client } = await g.requireRole(laneId, CONNECT_ROLES);
      if (!(await enabled(client, laneId))) return json({ error: "not_found" }, 404);
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
