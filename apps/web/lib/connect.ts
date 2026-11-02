// Connect-flow glue for the /api/connect routes (T-035): the OAuth flow lives in @nichols/connectors/oauth; this only
// supplies the request's session guard (owner or admin_technical of the lane, at aal2).
import { CONNECT_ROLES, type AuthorizeFn } from "@nichols/connectors/oauth";
import { guards } from "@/lib/guards";

export async function connectAuthorizer(): Promise<AuthorizeFn> {
  const { requireRole } = await guards();
  return async (laneId) => {
    const { session, client } = await requireRole(laneId, CONNECT_ROLES);
    return { userId: session.userId, client };
  };
}

export const NO_STORE = { "cache-control": "no-store" } as const;
