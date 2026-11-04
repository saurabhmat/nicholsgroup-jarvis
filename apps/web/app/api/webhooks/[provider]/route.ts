// Provider webhooks (T-036): POST /api/webhooks/<provider>. The whole pipeline (signature, replay window, dedupe, lane
// resolution from server data, enqueue) is in @nichols/connectors/webhooks; providers register there. No session, no
// cookies: the proxy does not touch this path and the provider's signature is the credential. Never cached.
import { receiveWebhook } from "@nichols/connectors/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/[provider]">) {
  return receiveWebhook(request, (await ctx.params).provider);
}

// Other methods: Next answers 405 itself (no handler exported); the pipeline also refuses them.
