// Starts an OAuth connect (T-035): POST /api/connect/<provider>/start?lane=PKG from a same-origin form. Owner or
// admin_technical of the lane at aal2; answers 303 to the provider's consent page. The logic is in
// @nichols/connectors/oauth (createConnectHandlers) where it is tested.
import { createConnectHandlers, oauthFlow } from "@nichols/connectors/oauth";
import { connectAuthorizer } from "@/lib/connect";

const handlers = createConnectHandlers(oauthFlow, connectAuthorizer);

export async function POST(request: Request, ctx: RouteContext<"/api/connect/[provider]/start">) {
  return handlers.start(request, (await ctx.params).provider);
}
