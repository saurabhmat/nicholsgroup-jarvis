// Settings → Connections "Test" for a Composio account (T-219): POST /api/connect/composio/test?lane=PKG&toolkit=gmail.
// Read-only identity + one page read; answers a status and a time only.
import { composioHandlers } from "@/lib/composio-routes";

export async function POST(request: Request) {
  return composioHandlers.test(request);
}
