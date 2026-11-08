import { describe, expect, it } from "vitest";
import { createToolRegistry, registerAssistantTools } from "@nichols/ai/tools";
import { AuthError } from "@nichols/core/auth";
import { interviewRequestSchema } from "@nichols/brain/interview";
import { handleInterview, type InterviewDeps } from "./brain-interview";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-0000000000aa";

type Rec = { fn: string; args: Record<string, unknown> };

/** A fake lane client for one lane: the core.* wrappers over an in-memory brain, plus lane_config / policies / connections. */
function laneClient(opts: { brainLanes?: string[]; financeLanes?: string[]; state?: { doc?: { body: string; version: number } | null } } = {}) {
  const calls: Rec[] = [];
  const docs = new Map<string, { body: string; version: number }>();
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    switch (fn) {
      case "allowed_lanes":
        return { data: args.p_view === "brain" ? (opts.brainLanes ?? ["TST"]) : (opts.financeLanes ?? ["TST"]), error: null };
      case "brain_home_lane":
        return { data: null, error: null };
      case "brain_document_get": {
        const d = docs.get(`${String(args.p_lane)}|${String(args.p_path)}`);
        return { data: d ? [{ id: ID, path: args.p_path, kind: "about_me", body_md: d.body, version: d.version, updated_at: "2026-11-08T00:00:00Z", is_mine: true }] : [], error: null };
      }
      case "brain_document_save": {
        const k = `${String(args.p_lane)}|${String(args.p_path)}`;
        const v = (docs.get(k)?.version ?? 0) + 1;
        docs.set(k, { body: String(args.p_body), version: v });
        return { data: [{ o_id: ID, o_version: v, o_updated_at: "2026-11-08T00:00:00Z" }], error: null };
      }
      case "brain_employees_list":
        return { data: [], error: null };
      default:
        return { data: null, error: { code: "XX000", message: "unexpected" } };
    }
  };
  const table = (name: string) => {
    const result =
      name === "lane_config_current"
        ? { data: { config: { mailboxes: ["ops@example.test"], kpis: ["mrr"] } }, error: null }
        : name === "lane_policies"
          ? { data: { llm_allowed_categories: ["email"], store_outbound_drafts: true, write_actions_allowed: ["email_draft"] }, error: null }
          : { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
    b.maybeSingle = async () => result;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
    return b;
  };
  const client = { schema: () => ({ rpc, from: table }) };
  return { client, calls, docs };
}

function deps(over: { role?: "owner" | "viewer" | "none"; lc?: ReturnType<typeof laneClient> } = {}): { d: InterviewDeps; lc: ReturnType<typeof laneClient> } {
  const lc = over.lc ?? laneClient();
  const d: InterviewDeps = {
    guards: async () => ({
      requireSession: async () => ({ userId: USER }) as never,
      requireLane: async (laneId: string) => ({ session: { userId: USER }, laneId, client: lc.client }) as never,
      requireRole: async (laneId: string) => {
        if (over.role === "viewer" || over.role === "none") throw new AuthError("forbidden");
        return { session: { userId: USER }, laneId, client: lc.client } as never;
      },
      listLanes: async () => [{ laneId: "TST", name: "Test Co" }] as never,
    }),
    now: () => new Date("2026-11-08T12:00:00Z"),
  };
  return { d, lc };
}

const req = (body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/lanes/TST/brain/interview", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).length), "sec-fetch-site": "same-origin", ...headers },
  });
};
const saves = (lc: ReturnType<typeof laneClient>) => lc.calls.filter((c) => /_save$/.test(c.fn));
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("request checks", () => {
  it("refuses cross-site, non-JSON, oversized, malformed and unknown requests before any work", async () => {
    const { d, lc } = deps();
    expect((await handleInterview(req({ action: "state" }, { "sec-fetch-site": "cross-site" }), "TST", d)).status).toBe(403);
    expect((await handleInterview(req({ action: "state" }, { "content-type": "text/plain" }), "TST", d)).status).toBe(415);
    expect((await handleInterview(req({ action: "state" }, { "content-length": "999999" }), "TST", d)).status).toBe(400);
    expect((await handleInterview(req("{nope"), "TST", d)).status).toBe(400);
    expect((await handleInterview(req({ action: "drop_tables" }), "TST", d)).status).toBe(400);
    expect((await handleInterview(req({ action: "state", extra: 1 }), "TST", d)).status).toBe(400);
    expect((await handleInterview(req({ action: "save", group: "A-1", answers: {}, proposalId: "nothex" }), "TST", d)).status).toBe(400);
    expect(lc.calls).toEqual([]);
  });
  it("the schema accepts the five actions", () => {
    for (const body of [{ action: "state" }, { action: "confirm" }, { action: "activate" }, { action: "propose", group: "A-1", answers: {} }, { action: "save", group: "A-1", answers: {}, proposalId: "a".repeat(64) }]) {
      expect(interviewRequestSchema.safeParse(body).success).toBe(true);
    }
  });
});

describe("who may run it", () => {
  it("a non-owner is refused with 403 and nothing is read", async () => {
    const { d, lc } = deps({ role: "viewer" });
    const res = await handleInterview(req({ action: "state" }), "TST", d);
    expect(res.status).toBe(403);
    expect(lc.calls).toEqual([]);
  });
  it("a lane without the brain view for this user is refused", async () => {
    const { d } = deps({ lc: laneClient({ brainLanes: [] }) });
    expect((await handleInterview(req({ action: "state" }), "TST", d)).status).toBe(403);
  });
  it("a lane the user can open but whose id is not in the brain lanes is not offered or written (cross-lane denial)", async () => {
    const lc = laneClient({ brainLanes: ["TST"] });
    const { d } = deps({ lc });
    const res = await handleInterview(req({ action: "state" }), "OTH", d);
    expect(res.status).toBe(403);
    expect(saves(lc)).toEqual([]);
  });
});

describe("state, propose and save over HTTP", () => {
  it("state and propose never write; save writes only the proposed page through the document writer", async () => {
    const { d, lc } = deps();
    const state = (await (await handleInterview(req({ action: "state" }), "TST", d)).json()) as Json;
    expect(state.ok).toBe(true);
    expect(state.state.homeLane).toBe("TST");
    expect(state.state.testBriefing).toEqual({ available: false, message: "Your test briefing arrives with the daily briefing (T-213)." });
    expect(state.state.sources[0]).toMatchObject({ laneId: "TST", settingsPath: "/TST/settings#connections", noMailboxes: false });
    // B2 offers the lane's mailbox, marked not connected: the chat links to Settings and never connects.
    const b2 = state.state.groups.flatMap((g: Json) => g.questions).find((q: Json) => q.id === "B2");
    expect(b2.fields[0].options).toEqual([{ value: "TST|ops@example.test", label: "ops@example.test (Test Co)", note: "not_connected" }]);

    const answers = { A1: { name: "Pat" } };
    const proposed = (await (await handleInterview(req({ action: "propose", group: "A-1", answers }), "TST", d)).json()) as Json;
    expect(proposed.proposal.changes[0]).toMatchObject({ kind: "document", path: "Context/About-Me.md", baseVersion: 0 });
    expect(saves(lc)).toEqual([]);

    const saved = await handleInterview(req({ action: "save", group: "A-1", answers, proposalId: proposed.proposal.proposalId }), "TST", d);
    expect(saved.status).toBe(200);
    expect(saves(lc)).toHaveLength(1);
    expect(saves(lc)[0]).toMatchObject({ fn: "brain_document_save", args: { p_lane: "TST", p_path: "Context/About-Me.md", p_if_version: 0 } });
  });
  it("save with a different answer than the proposal is a 409 and writes nothing", async () => {
    const { d, lc } = deps();
    const p = (await (await handleInterview(req({ action: "propose", group: "A-1", answers: { A1: { name: "Pat" } } }), "TST", d)).json()) as Json;
    const res = await handleInterview(req({ action: "save", group: "A-1", answers: { A1: { name: "Mallory" } }, proposalId: p.proposal.proposalId }), "TST", d);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error).toBe("proposal_changed");
    expect(saves(lc)).toEqual([]);
  });
  it("invalid answers are 422 with paths only; credentials and Nichols Law text are refused without echo", async () => {
    const { d, lc } = deps();
    const bad = await handleInterview(req({ action: "propose", group: "B-3", answers: { B6: { days_ahead: 50 } } }), "TST", d);
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "invalid_answers", issues: [{ code: "invalid_answer", path: "B6.days_ahead" }] });
    const secret = await handleInterview(req({ action: "propose", group: "A-1", answers: { A3: { first_task: "key sk_live_abcdefghijklmnop1234" } } }), "TST", d);
    expect(secret.status).toBe(422);
    expect(JSON.stringify(await secret.json())).not.toContain("sk_live");
    const nl = await handleInterview(req({ action: "propose", group: "A-3", answers: { A6: { company: "Nichols Law matter", people: "" } } }), "TST", d);
    expect(((await nl.json()) as Json).error).toBe("nichols_law");
    expect(saves(lc)).toEqual([]);
  });
  it("confirm and activate without a saved profile are 409", async () => {
    const { d } = deps();
    expect((await handleInterview(req({ action: "confirm" }), "TST", d)).status).toBe(409);
    expect((await handleInterview(req({ action: "activate" }), "TST", d)).status).toBe(409);
  });
});

describe("the model has no way to save", () => {
  it("the assistant tool registry holds only read tools: no brain, employee or save tool exists for a model to call", () => {
    const tools = registerAssistantTools(createToolRegistry()).list();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.effect).toBe("read");
      expect(t.name).not.toMatch(/brain|employee|document|save|memory|interview|activate/);
    }
  });
});
