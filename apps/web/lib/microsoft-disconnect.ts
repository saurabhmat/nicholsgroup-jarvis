// Local Disconnect of a Microsoft mailbox (T-257, D-55): POST /api/lanes/<lane>/connections/<id>/disconnect.
//  - Who: the mailbox OWNER, signed in at AAL2, holding own_mail in the lane. No session 401; AAL1 or a role without own_mail 403; a lane that is
//    not the caller's, an unknown or malformed id, another lane's connection, another person's mailbox or a row of another provider 404.
//  - Cross-site: Origin must be this site (the confirm button's fetch); Sec-Fetch-Site other than same-origin is 403.
//  - Effect: the Vault tokens are deleted and the row becomes `disconnected`, audited (`connection.disconnected`, the user as actor) by one database
//    function. It is LOCAL: no request to Microsoft is made (so it is not an external write, rule 5, and does not go through approvals; D-55).
//  - Answers are fixed JSON codes; nothing from an error is passed on.
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import { MAIL_CONNECT_ROLES } from "@nichols/connectors/oauth";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status: number) => Response.json(body, { status, headers: NO_STORE });
const LANE = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MicrosoftDisconnectDeps = {
  guards: () => Promise<Pick<Guards, "requireLane" | "requireRole">>;
  /** The connector's local disconnect: resolves when done; throws a ConnectorError (`not_found` for another lane's, person's or provider's row). */
  disconnect: (laneId: string, connectionId: string, actorUserId: string) => Promise<unknown>;
};

export function createMicrosoftDisconnectHandler(deps: MicrosoftDisconnectDeps) {
  return async function POST(request: Request, laneId: string, connectionId: string): Promise<Response> {
    const url = new URL(request.url);
    const site = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== url.origin || (site !== null && site !== "same-origin")) return json({ error: "forbidden" }, 403);
    if (!LANE.test(laneId) || !UUID.test(connectionId)) return json({ error: "not_found" }, 404);
    try {
      const g = await deps.guards();
      try {
        await g.requireLane(laneId);
      } catch (e) {
        if (e instanceof AuthError && e.reason === "forbidden") return json({ error: "not_found" }, 404);
        throw e;
      }
      const { session } = await g.requireRole(laneId, [...MAIL_CONNECT_ROLES]); // the own_mail roles; AAL2 enforced by the guard
      await deps.disconnect(laneId, connectionId.toLowerCase(), session.userId);
      return json({ status: "disconnected" }, 200);
    } catch (e) {
      const res = authErrorResponse(e);
      if (res) return res;
      if ((e as { info?: { kind?: unknown } } | null)?.info?.kind === "not_found") return json({ error: "not_found" }, 404);
      console.error("[api/microsoft-disconnect] unavailable:", e instanceof Error ? e.name : typeof e);
      return json({ error: "unavailable" }, 503);
    }
  };
}
