// OAuth callback (T-035): the provider redirects the browser here with `code` and `state`. The flow re-checks the
// session, exchanges the code and stores the token in the Vault, then the user is sent home with a coarse result code.
// The logic is in @nichols/connectors/oauth (createConnectHandlers) where it is tested.
import { createConnectHandlers, oauthFlow } from "@nichols/connectors/oauth";
import { sendLaneEvent } from "@nichols/core/inngest";
import { connectAuthorizer } from "@/lib/connect";
import { connectFollowUp } from "@/lib/connect-follow-up";

// T-241: a QuickBooks connect or reconnect starts its full initial load at once (sendLaneEvent validates the event and the lane).
const handlers = createConnectHandlers(oauthFlow, connectAuthorizer, { onConnected: connectFollowUp((e) => sendLaneEvent(e)) });

export async function GET(request: Request, ctx: RouteContext<"/api/connect/[provider]/callback">) {
  return handlers.callback(request, (await ctx.params).provider);
}
