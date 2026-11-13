// `@nichols/connectors/oauth` (T-035): the connect flow wired to the real state store, connection store, token vault
// and audit log. apps/web's /api/connect/[provider]/start and /callback routes are thin wrappers over this; the token
// exchange and the Vault write stay inside packages/connectors. Server-only.
import { getAudit } from "@nichols/core/lane-router";
import { connectionStore, storeToken } from "../vault/index";
import { createOAuthFlow } from "./flow";
import { OAUTH_PROVIDERS } from "./registry";
import { dbStateStore } from "./state";

export { createConnectHandlers, type OnConnected } from "./handlers";
export { CONNECT_ROLES, type AuthorizeFn, type Authorized, type CallbackResult, type ConnectFailure } from "./flow";

export const oauthFlow = createOAuthFlow({
  providers: OAUTH_PROVIDERS,
  states: dbStateStore,
  connections: connectionStore,
  storeToken,
  audit: getAudit(),
});
