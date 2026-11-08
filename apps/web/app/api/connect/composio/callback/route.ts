// Composio's redirect back (T-219): GET /api/connect/composio/callback?state=…; the flow checks the single-use state
// (bound to user + lane + toolkit + the connected account created at start), the account and the address, then sends the
// user to the lane's Settings with a coarse result code.
import { composioHandlers } from "@/lib/composio-routes";

export async function GET(request: Request) {
  return composioHandlers.callback(request);
}
