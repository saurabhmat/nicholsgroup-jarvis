// Starts an OAuth connect (T-035): POST /api/connect/<provider>/start?lane=PKG from a same-origin form. Owner or
// admin_technical of the lane at aal2; answers 303 to the provider's consent page. POST + Origin check, because
// starting a connect creates server state and must not be triggered by another site.
import { authErrorResponse } from "@nichols/core/auth";
import { oauthFlow } from "@nichols/connectors/oauth";
import { connectAuthorizer, NO_STORE } from "@/lib/connect";

export async function POST(request: Request, ctx: RouteContext<"/api/connect/[provider]/start">) {
  const { provider } = await ctx.params;
  if (!oauthFlow.has(provider)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  try {
    const location = await oauthFlow.start(provider, url.searchParams.get("lane") ?? "", await connectAuthorizer());
    return new Response(null, { status: 303, headers: { ...NO_STORE, location } });
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    const kind = (e as { info?: { kind?: string } } | null)?.info?.kind;
    if (kind === "forbidden") return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    if (kind === "rate_limited") return Response.json({ error: "too_many_connects" }, { status: 429, headers: NO_STORE });
    console.error("[api/connect/start] unavailable:", e instanceof Error ? e.name : typeof e);
    return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
