import "server-only";
// The Teams guard, token manager, error sink and guarded READ client over the real Vault, lane router (through the vault module) and connector env (T-279; split out of index.ts in T-286 so the
// approvals-only writer wiring file shares the SAME guard and token manager as the reader instead of building a second set). Server-only. Nothing here names the write client:
// it is built in the writer wiring file only (write-boundary.test.ts proves it). Imported by the Teams index and the writer wiring file and by nothing else.
import { requireConnectorEnv } from "@nichols/core/env/server";
import { attentionEventId, connAttentionNeeded, sendLaneEvent } from "@nichols/core/inngest";
import { createApiErrorSink } from "../error-log/sink";
import { classifyGraphFailure } from "../microsoft/errors";
import { createReconnectRecorder } from "../quickbooks/reconnect";
import { apiErrorStore, connectionLoader, getToken, laneConfigReader, reconnectStore, rotateToken, teamsIdentityReader } from "../vault/index";
import { SecretValue } from "../vault/secret";
import { createTeamsApi } from "./api";
import { createTeamsGuard } from "./guard";
import { createTeamsTokenManager } from "./token-manager";

function client() {
  const env = requireConnectorEnv("graph_teams");
  return { clientId: env.GRAPH_TEAMS_CLIENT_ID, clientSecret: new SecretValue(env.GRAPH_TEAMS_CLIENT_SECRET) };
}

export const guard = createTeamsGuard({
  connections: { load: (laneId, id) => connectionLoader.loadConnection(laneId, id) },
  laneConfig: laneConfigReader,
  identity: teamsIdentityReader,
});

/** A refresh token Microsoft refused: the connection is recorded as reconnect_required and the admin is notified (T-195 recorder, same as mail and QuickBooks). */
const onReconnectRequired = createReconnectRecorder({
  store: reconnectStore,
  notify: async ({ laneId, connectionId, provider, errorKind }) => {
    await sendLaneEvent(connAttentionNeeded.create({ laneId, connectionId, provider, reason: "reconnect_required", errorKind }, { id: attentionEventId(laneId, connectionId, "reconnect_required", new Date()) }));
  },
});

export const tokens = createTeamsTokenManager({ vault: { getToken, rotateToken }, client, onReconnectRequired });
export const errors = createApiErrorSink({ store: apiErrorStore, messageFor: (info) => classifyGraphFailure(info).message });

/** The guarded, read-only Teams Graph client (GET only, exact path templates, a named actor on every call). */
export const teamsApi = createTeamsApi({ guard, tokens, errors });
