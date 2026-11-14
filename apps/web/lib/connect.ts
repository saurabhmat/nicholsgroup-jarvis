// Connect-flow glue for the /api/connect routes (T-035): the OAuth flow lives in @nichols/connectors/oauth; this only
// supplies the request's session guard at aal2. Who may connect depends on the provider (T-247): a person's own Google account is
// connected by the person (any member who holds own_mail: owner, admin_technical, viewer); every other provider (QuickBooks, ...) stays
// owner or admin_technical. The database checks again (core.oauth_state_create / consume).
import { connectRolesFor, type AuthorizeFn } from "@nichols/connectors/oauth";
import { guards } from "@/lib/guards";

export async function connectAuthorizer(): Promise<AuthorizeFn> {
  const { requireRole } = await guards();
  return async (laneId, provider) => {
    const { session, client } = await requireRole(laneId, [...connectRolesFor(provider ?? "")]);
    return { userId: session.userId, client };
  };
}
