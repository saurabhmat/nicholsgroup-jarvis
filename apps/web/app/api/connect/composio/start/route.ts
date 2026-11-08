// Starts a Composio connect (T-219): POST /api/connect/composio/start?lane=PKG&toolkit=gmail from a same-origin form on
// Settings → Connections. Owner or admin_technical at aal2; answers 303 to the Composio-hosted consent page. The chat
// never reaches this route (it may only link to Settings).
import { composioHandlers } from "@/lib/composio-routes";

export async function POST(request: Request) {
  return composioHandlers.start(request);
}
