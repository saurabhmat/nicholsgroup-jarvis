// Memory import API (T-220, spec brain-and-employees §7a; D-39, D-40). POST /api/lanes/:laneId/brain/import with one of
//   extract | propose | save | discard | page_propose | page_save
// Order: same-origin JSON with a bounded body -> strict body schema -> AAL2 session + OWNER role in the lane (guards) -> the
// brain view and the home lane (same gate as the interview and onboarding; a real 404 for anyone else is the page's and the
// proxy's job, this route answers 403) -> for `extract` only: AI configured -> the policy gate core.ai_tool_gate(home lane,
// 'brain', the import category) -> the model, in the request, on the bounded text (nothing is stored but the candidate rows) -> the
// brain module (@nichols/brain/server import). Files are read in the browser and never reach this route; only the selected text
// (at most 50,000 characters) does. Writes happen only through the brain store's reviewed writers over the session-bound
// lane client (never the service role), and only on `save` / `page_save`, with the exact proposal the user saw.
// Errors carry a code only; logs name the class only: never pasted text, facts or quotes.
import { authErrorResponse, AuthError, type Guards } from "@nichols/core/auth";
import type { ProviderResult } from "@nichols/ai/config";
import { IMPORT_POLICY_CATEGORY, importRequestSchema } from "@nichols/brain/import";
import {
  BrainError,
  EmployeeConfigError,
  ImportPartialSave,
  InterviewRefusal,
  discardImport,
  extractCandidates,
  proposeImport,
  proposePage,
  saveImport,
  savePage,
} from "@nichols/brain/server";
import { buildEnv } from "@/lib/brain-interview";
import { ImportModelError, createExtractor } from "@/lib/brain-import-model";

/** 50,000 characters can be up to 200,000 bytes in UTF-8, plus JSON escaping and the other fields. */
export const MAX_BODY_BYTES = 420_000;

export type ImportDeps = {
  guards: () => Promise<Pick<Guards, "requireSession" | "requireLane" | "requireRole" | "listLanes">>;
  provider: () => ProviderResult;
  now: () => Date;
};

type Rpc = { schema: (s: "core") => { rpc: (fn: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> } };

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The home lane's policy gate for the import's model call (D-40). Anything but an explicit allow fails closed. */
export async function importGate(client: unknown, homeLane: string): Promise<"allowed" | "not_allowed" | "rate_limited" | "forbidden" | "unavailable"> {
  try {
    const { data, error } = await (client as Rpc).schema("core").rpc("ai_tool_gate", { p_lane: homeLane, p_view: "brain", p_category: IMPORT_POLICY_CATEGORY });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return "unavailable";
    const v = data as { allowed?: unknown; reason?: unknown };
    if (v.allowed === true) return "allowed";
    if (v.reason === "category_denied") return "not_allowed";
    if (v.reason === "rate_limited") return "rate_limited";
    return v.reason === "mfa_required" || v.reason === "not_member" || v.reason === "role_denied" || v.reason === "view_denied" || v.reason === "lane_disabled" ? "forbidden" : "unavailable";
  } catch {
    return "unavailable";
  }
}

const BRAIN_STATUS: Record<string, number> = { forbidden: 403, version_conflict: 409, rate_limited: 429, unavailable: 503 };

function errorResponse(e: unknown): Response {
  if (e instanceof ImportPartialSave) return json(409, { error: "partial_save", saved: e.saved });
  if (e instanceof ImportModelError) return json(e.code === "timeout" ? 504 : 502, { error: e.code });
  if (e instanceof EmployeeConfigError) return json(422, { error: "config_invalid" });
  if (e instanceof InterviewRefusal) {
    const status = e.code === "import_not_found" ? 404 : e.code === "proposal_changed" || e.code === "profile_invalid" ? 409 : 422;
    return json(status, { error: e.code });
  }
  if (e instanceof BrainError) return json(BRAIN_STATUS[e.code] ?? 422, { error: e.code });
  console.error("[brain-import] unavailable:", e instanceof Error ? e.name : typeof e);
  return json(503, { error: "unavailable" });
}

export async function handleImport(request: Request, laneId: string, deps: ImportDeps): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json(403, { error: "forbidden" });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "invalid_request" });
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  let g: Awaited<ReturnType<ImportDeps["guards"]>>;
  let userId: string;
  try {
    g = await deps.guards();
    const ctx = await g.requireRole(laneId, ["owner"]); // the brain is owner-only (spec §3); the database checks again
    userId = ctx.session.userId;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    console.error("[brain-import] unavailable:", e instanceof Error ? e.name : typeof e);
    return json(503, { error: "unavailable" });
  }

  // Authenticated before the body is read (T-220 security L5): a signed-out caller cannot make the server buffer 400 KB.
  const raw = await request.text().catch(() => "");
  if (raw.length === 0 || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const parsed = importRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request" });
  const req = parsed.data;

  try {
    const built = await buildEnv(g, laneId, userId, deps.now());
    if ("refused" in built) return json(built.refused === "forbidden" ? 403 : 409, { error: built.refused });
    const { env } = built;
    switch (req.action) {
      case "extract": {
        const p = deps.provider();
        if (!p.configured) return json(503, { error: "not_configured" });
        const homeClient = (await g.requireLane(env.ctx.home)).client;
        const gate = await importGate(homeClient, env.ctx.home);
        if (gate !== "allowed") return json(gate === "not_allowed" || gate === "forbidden" ? 403 : gate === "rate_limited" ? 429 : 503, { error: gate });
        const out = await extractCandidates(env, req.source, req.text, createExtractor(p.provider, env.ctx.home, req.source));
        return json(200, { ok: true, ...out });
      }
      case "propose":
        return json(200, { ok: true, proposal: await proposeImport(env, req.importId, req.items) });
      case "save":
        return json(200, { ok: true, ...(await saveImport(env, req.importId, req.items, req.proposalId)) });
      case "discard":
        return json(200, { ok: true, ...(await discardImport(env, req.importId)) });
      case "page_propose":
        return json(200, { ok: true, proposal: await proposePage(env, req.target, req.text) });
      case "page_save":
        return json(200, { ok: true, ...(await savePage(env, req.target, req.text, req.proposalId)) });
      default:
        return json(400, { error: "invalid_request" });
    }
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e) as Response;
    return errorResponse(e);
  }
}
