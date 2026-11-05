// Step-up check (T-020): 200 when the user entered an authenticator code within `maxAge` seconds (default 300, the
// approvals default), 403 `step_up_required` otherwise. No data; screens use it before offering sensitive actions,
// and the actions themselves call requireStepUp() again server-side.
import { authErrorResponse } from "@nichols/core/auth";
import { guards } from "@/lib/guards";

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("maxAge");
  const maxAge = raw === null ? 300 : Number(raw);
  try {
    await (await guards()).requireStepUp(maxAge);
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    console.error("[api/session/step-up] unavailable:", e instanceof Error ? e.name : typeof e);
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
