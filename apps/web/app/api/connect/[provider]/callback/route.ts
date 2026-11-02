// OAuth callback (T-035): the provider redirects the browser here with `code` and `state`. The flow re-checks the
// session (same user who started, owner/admin_technical at aal2), exchanges the code and stores the token in the Vault,
// then the user is sent home with a coarse result code. Provider text never reaches the page.
import { authErrorResponse } from "@nichols/core/auth";
import { oauthFlow } from "@nichols/connectors/oauth";
import { connectAuthorizer, NO_STORE } from "@/lib/connect";

export async function GET(request: Request, ctx: RouteContext<"/api/connect/[provider]/callback">) {
  const { provider } = await ctx.params;
  if (!oauthFlow.has(provider)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const url = new URL(request.url);
  try {
    const result = await oauthFlow.callback(provider, url.searchParams, await connectAuthorizer());
    const home = new URL("/", url.origin);
    home.searchParams.set("connect", result.ok ? "ok" : result.reason);
    if (result.provider) home.searchParams.set("provider", result.provider);
    return new Response(null, { status: 303, headers: { ...NO_STORE, location: home.pathname + home.search, "referrer-policy": "no-referrer" } });
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    console.error("[api/connect/callback] unavailable:", e instanceof Error ? e.name : typeof e);
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
