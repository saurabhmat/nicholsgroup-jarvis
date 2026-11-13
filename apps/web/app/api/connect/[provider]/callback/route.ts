// OAuth callback (T-035): the provider redirects the browser here with `code` and `state`. The flow re-checks the
// session, exchanges the code and stores the token in the Vault, then the user is sent home with a coarse result code.
// The logic is in @nichols/connectors/oauth (createConnectHandlers) where it is tested.
import { createConnectHandlers, oauthFlow } from "@nichols/connectors/oauth";
import { resetSyncCursorForReload } from "@nichols/connectors/sync";
import { sendLaneEvent } from "@nichols/core/inngest";
import { connectAuthorizer } from "@/lib/connect";
import { connectFollowUp } from "@/lib/connect-follow-up";
import type { LaneId } from "@nichols/core";

// T-241: a QuickBooks connect or reconnect drops its stored sync cursor and starts its full initial load at once (sendLaneEvent
// validates the event and the lane).
const handlers = createConnectHandlers(oauthFlow, connectAuthorizer, { onConnected: connectFollowUp((e) => sendLaneEvent(e), (laneId, connectionId) => resetSyncCursorForReload(laneId as LaneId, connectionId)) });

export async function GET(request: Request, ctx: RouteContext<"/api/connect/[provider]/callback">) {
  return handlers.callback(request, (await ctx.params).provider);
}
