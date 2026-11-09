// Setup interview API (T-216, spec brain-and-employees §7). POST /api/lanes/:laneId/brain/interview with one of
//   state | propose | save | confirm | activate
// Order: same-origin JSON with a bounded body -> body schema -> AAL2 session + OWNER role in the lane (guards) ->
// brain lane facts read through the user's own lane clients -> the interview server logic (@nichols/brain/server).
// `state` and `propose` are read-only; only `save` and `activate` write, and only through the brain store's reviewed
// writers (security-definer functions over the session-bound lane client: never the service role). No model is called
// and nothing here talks to an external system. Errors carry a code only; logs name the class only.
import { AuthError, authErrorResponse, type Guards } from "@nichols/core/auth";
import { KPI_IDS } from "@nichols/core/lane-config";
import { resolveHomeLane } from "@nichols/brain";
import { AnswerError, interviewRequestSchema, type InterviewCtx, type LaneInfo } from "@nichols/brain/interview";
import {
  BrainError,
  EmployeeConfigError,
  InterviewRefusal,
  activateEmployee,
  completeGroup,
  confirmSetup,
  createBrainStore,
  loadInterviewState,
  proposeGroup,
  saveGroup,
  type BrainStore,
  type ClientFor,
  type InterviewEnv,
} from "@nichols/brain/server";
import { loadGoogleSection } from "@/lib/google-connection";

export const MAX_BODY_BYTES = 40_000;

export type InterviewDeps = {
  guards: () => Promise<Pick<Guards, "requireSession" | "requireLane" | "requireRole" | "listLanes">>;
  now: () => Date;
};

type Client = Awaited<ReturnType<Guards["requireLane"]>>["client"];
type Rpc = { schema: (s: "core") => { rpc: (fn: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> } };

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** IANA zones the Timezone question offers. */
export function timezoneList(): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [...new Set(["America/New_York", ...zones, "UTC"])];
}

/** The lanes where the caller has the brain view (core.allowed_lanes, own uid at AAL2). [] on any error: fail closed. */
export async function brainLanes(client: Client, userId: string, view: string): Promise<string[]> {
  try {
    const { data, error } = await (client as unknown as Rpc).schema("core").rpc("allowed_lanes", { p_uid: userId, p_view: view });
    return !error ? strings(data) : [];
  } catch {
    return [];
  }
}

/** Mailboxes and KPIs from lane_config, the policy and the connection state of one lane, read with the user's own lane client. */
export async function readLaneInfo(client: Client, laneId: string, name: string, financeView: boolean, withConnections = true): Promise<LaneInfo | null> {
  const core = client.schema("core");
  const [cfg, pol] = await Promise.all([
    core.from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle(),
    core.from("lane_policies").select("llm_allowed_categories, store_outbound_drafts, write_actions_allowed").eq("lane_id", laneId).maybeSingle(),
  ]);
  if (cfg.error || pol.error || !cfg.data || !pol.data) return null;
  const config = (typeof cfg.data.config === "object" && cfg.data.config !== null ? cfg.data.config : {}) as { mailboxes?: unknown; kpis?: unknown };
  // An unreadable state is "unknown", never "missing". Progress callers skip the lookup (connection state never changes completion).
  let connected: string[] | null = null;
  if (withConnections) {
    try {
      const g = await loadGoogleSection(client, laneId);
      connected = g.unavailable ? null : g.connections.filter((c) => c.state === "connected" || c.state === "degraded").map((c) => c.mailbox.toLowerCase());
    } catch {
      connected = null;
    }
  }
  return {
    laneId,
    name,
    mailboxes: strings(config.mailboxes),
    kpis: strings(config.kpis).filter((k) => (KPI_IDS as readonly string[]).includes(k)),
    connected,
    policy: {
      write_actions_allowed: strings(pol.data.write_actions_allowed),
      store_outbound_drafts: pol.data.store_outbound_drafts === true,
      llm_allowed_categories: strings(pol.data.llm_allowed_categories),
    },
    financeView,
  };
}

export type Env = { env: InterviewEnv & { store: BrainStore } };

/** Builds the interview environment: open lanes (router + brain view), the home lane (spec §3), lane facts. */
export async function buildEnv(g: Awaited<ReturnType<InterviewDeps["guards"]>>, laneId: string, userId: string, now: Date): Promise<Env | { refused: "forbidden" | "home_lane_unavailable" }> {
  const clients = new Map<string, ReturnType<ClientFor>>();
  const clientFor: ClientFor = (l) => {
    let c = clients.get(l);
    if (c === undefined) {
      c = g.requireLane(l).then((r) => r.client as never);
      clients.set(l, c);
    }
    return c;
  };
  const current = (await clientFor(laneId)) as unknown as Client;
  const withBrain = new Set(await brainLanes(current, userId, "brain"));
  if (!withBrain.has(laneId)) return { refused: "forbidden" };
  const withFinance = new Set(await brainLanes(current, userId, "finance"));
  const names = new Map((await g.listLanes().catch(() => [])).map((l) => [l.laneId, l.name] as const));
  // Only lanes the lane router opens for this session, at most ten.
  const infos: LaneInfo[] = [];
  await Promise.all(
    [...withBrain].slice(0, 10).map(async (l) => {
      try {
        const client = (await clientFor(l)) as unknown as Client;
        const info = await readLaneInfo(client, l, names.get(l) ?? l, withFinance.has(l));
        if (info) infos.push(info);
      } catch {
        // a lane the router refuses or that cannot be read is not offered
      }
    }),
  );
  const open = infos.map((i) => i.laneId).sort();
  const store = createBrainStore({
    clientFor,
    laneSettingsFor: async (l) => {
      const i = infos.find((x) => x.laneId === l);
      return i ? { mailboxes: i.mailboxes, kpis: i.kpis } : null;
    },
  });
  let existing: string | null = null;
  try {
    existing = await store.findHomeLane(laneId);
  } catch {
    existing = null;
  }
  // The lane the user is in is the pick when nothing else decides (spec §3: the lane picked in setup).
  const home = resolveHomeLane({ openLanes: open, existingLaneId: existing, pickedLaneId: open.includes(laneId) ? laneId : null });
  if (!home.ok) return { refused: home.reason === "home_lane_unavailable" ? "home_lane_unavailable" : "forbidden" };
  const ctx: InterviewCtx = { home: home.laneId, current: laneId, lanes: infos.sort((a, b) => a.laneId.localeCompare(b.laneId)), timezones: timezoneList() };
  return { env: { store, ctx, now } };
}

const STATUS: Record<string, number> = {
  forbidden: 403,
  version_conflict: 409,
  unavailable: 503,
};

function errorResponse(e: unknown): Response {
  if (e instanceof AnswerError) return json(422, { error: "invalid_answers", issues: e.issues });
  if (e instanceof EmployeeConfigError) return json(422, { error: "config_invalid", issues: e.issues });
  if (e instanceof InterviewRefusal) {
    const status = e.code === "nichols_law" || e.code === "unknown_group" ? 422 : 409;
    return json(status, { error: e.code });
  }
  if (e instanceof BrainError) return json(STATUS[e.code] ?? 422, { error: e.code });
  console.error("[brain-interview] unavailable:", e instanceof Error ? e.name : typeof e);
  return json(503, { error: "unavailable" });
}

export async function handleInterview(request: Request, laneId: string, deps: InterviewDeps): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return json(403, { error: "forbidden" });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "invalid_request" });
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  const raw = await request.text().catch(() => "");
  if (raw.length === 0 || new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json(400, { error: "invalid_request" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_request" });
  }
  const parsed = interviewRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request" });
  const req = parsed.data;

  let g: Awaited<ReturnType<InterviewDeps["guards"]>>;
  let userId: string;
  try {
    g = await deps.guards();
    const ctx = await g.requireRole(laneId, ["owner"]); // the brain is owner-only (spec §3); the database checks again
    userId = ctx.session.userId;
  } catch (e) {
    const res = authErrorResponse(e);
    if (res) return res;
    console.error("[brain-interview] unavailable:", e instanceof Error ? e.name : typeof e);
    return json(503, { error: "unavailable" });
  }

  try {
    const built = await buildEnv(g, laneId, userId, deps.now());
    if ("refused" in built) return json(built.refused === "forbidden" ? 403 : 409, { error: built.refused });
    const { env } = built;
    switch (req.action) {
      case "state":
        return json(200, { ok: true, state: await loadInterviewState(env) });
      case "propose":
        return json(200, { ok: true, proposal: await proposeGroup(env, req.group, req.answers) });
      case "save": {
        const saved = await saveGroup(env, req.group, req.answers, req.proposalId);
        return json(200, { ok: true, completed: saved.completed, state: await loadInterviewState(env) });
      }
      case "complete": {
        await completeGroup(env, req.group);
        return json(200, { ok: true, state: await loadInterviewState(env) });
      }
      case "confirm":
        return json(200, { ok: true, ...(await confirmSetup(env)) });
      case "activate": {
        await activateEmployee(env);
        return json(200, { ok: true, state: await loadInterviewState(env) });
      }
      default:
        return json(400, { error: "invalid_request" });
    }
  } catch (e) {
    if (e instanceof AuthError) return authErrorResponse(e) as Response;
    return errorResponse(e);
  }
}

/** Whether the setup entry points are offered on a page: owner role at AAL2 with the brain view in this lane. */
export async function brainSetupAvailable(g: Pick<Guards, "requireRole">, laneId: string): Promise<boolean> {
  try {
    const { client, session } = await g.requireRole(laneId, ["owner"]);
    return (await brainLanes(client, session.userId, "brain")).includes(laneId);
  } catch (e) {
    if (e instanceof AuthError) return false;
    throw e;
  }
}
