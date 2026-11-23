// The Teams token manager (T-279, spec 5 "Tokens"): the Microsoft token manager (microsoft/token-manager.ts: rotation on use, compare-and-swap in the Vault, single flight, the
// `reconnect_required` mapping, no retried refresh POST) over the TEAMS app's client credentials, accepting only a connection the TEAMS guard approved. A mail token cannot
// be refreshed here and a Teams token cannot be refreshed by the mail manager: each checks its own guard's brand.
import { createMicrosoftTokenManager, type MicrosoftTokenManager, type MicrosoftTokenManagerDeps } from "../microsoft/token-manager";
import { isGuardedTeams } from "./guard";
import { TEAMS_PROVIDER } from "./constants";

export type TeamsTokenManager = MicrosoftTokenManager;

export function createTeamsTokenManager(deps: Omit<MicrosoftTokenManagerDeps, "isApproved" | "logProvider">): TeamsTokenManager {
  return createMicrosoftTokenManager({ ...deps, isApproved: isGuardedTeams, logProvider: TEAMS_PROVIDER });
}
