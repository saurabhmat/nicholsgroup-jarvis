// The Teams token manager (T-279, spec 5 "Tokens"): the Microsoft token manager (microsoft/token-manager.ts: rotation on use, compare-and-swap in the Vault, single flight, the
// `reconnect_required` mapping, no retried refresh POST) over the TEAMS app's client credentials, accepting only a connection the TEAMS guard approved. A mail token cannot
// be refreshed here and a Teams token cannot be refreshed by the mail manager: each checks its own guard's brand.
import { createMicrosoftTokenManager, type MicrosoftTokenManager, type MicrosoftTokenManagerDeps } from "../microsoft/token-manager";
import { isGuardedTeams } from "./guard";
import { TEAMS_PROVIDER } from "./constants";
import { createTeamsTokenHttp } from "./http";
import { assertTeamsGrantedScopes } from "./provider";

export type TeamsTokenManager = MicrosoftTokenManager;

export function createTeamsTokenManager(deps: Omit<MicrosoftTokenManagerDeps, "isApproved" | "logProvider">): TeamsTokenManager {
  // The refresh goes to the sign-in host through a client labelled with the Teams provider (default: a test's own client).
  const httpFor: MicrosoftTokenManagerDeps["httpFor"] = deps.httpFor ?? ((laneId, connectionId, baseUrl) => createTeamsTokenHttp({ baseUrl, laneId, ...(connectionId ? { connectionId } : {}), ...(deps.logger ? { logger: deps.logger } : {}) }));
  // T-278 review S9: a refresh response that lists a scope outside the Teams app's own list (a `Mail.*` scope, another resource) is not stored; the connection needs a reconnect.
  const checkRefreshScope = (scope: string | undefined) => {
    if (scope !== undefined) assertTeamsGrantedScopes(scope, []);
  };
  return createMicrosoftTokenManager({ ...deps, httpFor, isApproved: isGuardedTeams, logProvider: TEAMS_PROVIDER, checkRefreshScope });
}
