// T-288 review D4: the REAL one-step send (`sendTeamsMessage` of `@nichols/approvals/wire`: propose, approve, claim, execute, verify, with the real `readFacts` and gates) behind the REAL route handler
// (`createTeamsRoutes(...).send`, wired exactly as the route file wires it), with only the outside world replaced: the lane router (a stateful fake of the approvals
// database functions that enforces the unique (connection, request id) rule and the single claim, and a counting fake writer. Two overlapping requests with the same request id make ONE action and ONE
// POST; two different ids with the same text make TWO POSTs (the accepted case: they are two intended messages; two tabs can do this). Synthetic data only.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { teamsSendFailureText, teamsTextHash } from "@nichols/approvals/server";

const reader = vi.hoisted(() => ({ resolveCallTargets: vi.fn(), listMessages: vi.fn(), listChats: vi.fn(), openChat: vi.fn(), fetchHostedImage: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ ...reader }));
// the database functions (a stateful fake, below), the audit log, and the Teams writer (counting); everything else in `wire.ts` is the real code
const world = vi.hoisted(() => ({ rpc: (async () => ({ data: null, error: null })) as (fn: string, a: Record<string, unknown>) => Promise<unknown>, posts: [] as { connection: string; text: unknown }[], logged: [] as string[] }));
vi.mock("@nichols/connectors/facade", () => ({ prepareEmailWrite: vi.fn(), laneMailboxes: vi.fn(), mailboxAllowed: vi.fn(), providerGate: { enabled: async () => true } }));
vi.mock("@nichols/connectors/write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@nichols/connectors/write")>()), // the pure parts (the text schema, the fixed sentences) are the real ones
  loadTeamsWriteConnection: async (_l: string, id: string) => ({ id }),
  teamsMessageReconciler: { findWrite: vi.fn(), verifyWrite: async () => undefined },
  teamsMessageWriter: {
    async executeWrite(_l: unknown, c: { id: string }, action: { payload: { text: unknown } }) {
      world.posts.push({ connection: c.id, text: action.payload.text });
      await new Promise((r) => setTimeout(r, 20)); // the POST takes a moment: a second request overlaps it
      return { outcome: "accepted", external_id: `g${world.posts.length}`, executed_at: new Date().toISOString(), provider_tid: null };
    },
  },
}));
vi.mock("@nichols/core/lane-router", () => ({
  getAudit: () => ({ log: async (e: unknown) => void world.logged.push(JSON.stringify(e)) }),
  getLaneJobClient: async () => laneClient(),
}));
const laneClient = () => ({
  schema: () => ({
    rpc: (fn: string, a: Record<string, unknown>) => world.rpc(fn, a),
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { provider: "microsoft_teams", external_account_id: "robert@pubkgroup.com", status: "active", features: { teams_chat_send: true }, owner_user_id: ME }, error: null }) }),
          maybeSingle: async () => ({ data: table === "lane_policies" ? { write_actions_allowed: ["teams_send"], store_outbound_drafts: true } : { config: { approvals: { approvals_live: true }, teams: { enabled: true, features: ["chat_send"] } } }, error: null }),
        }),
      }),
    }),
  }),
});
import { sendTeamsMessage, teamsStepUpWindow } from "@nichols/approvals/wire";

import { createTeamsRoutes } from "@/lib/teams-api";
import { createWindowLimiter } from "@/lib/teams-activity";
import { encodeChatKey } from "@/lib/teams-chat-key";

const ME = "00000000-0000-4000-8000-0000000000aa";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const CHAT = "19:abc123def456@thread.v2";
const KEY = encodeChatKey(CHAT);
const TEXT = "CANARY-combined-3c1d";
const ID1 = "5e11d0c0-0000-4000-8000-000000000001";
const ID2 = "5e11d0c0-0000-4000-8000-000000000002";

type Row = Record<string, unknown> & { id: string; status: string; payload: Record<string, unknown>; target: Record<string, unknown> };
function database() {
  const rows = new Map<string, Row>();
  const claims = new Map<string, { outcome: string | null; external_id: string | null }>();
  const err = (message: string, code = "P0001") => ({ data: null, error: { code, message } });
  const get = (id: unknown) => rows.get(String(id));
  const rpc = async (fn: string, a: Record<string, unknown>) => {
    switch (fn) {
      case "has_lane_role":
        return { data: true, error: null };
      case "act_propose": {
        // the unique index: one action per (connection, request id); the same id with other content is refused
        const dup = [...rows.values()].find((r) => r.connection_id === a.p_connection && (r.target as Record<string, unknown>).client_request_id === (a.p_target as Record<string, unknown>).client_request_id);
        if (dup) return dup.payload_sha256 === a.p_hash ? { data: dup.id, error: null } : err("act: client_request_id_reused", "23505");
        const id = randomUUID();
        rows.set(id, { id, lane_id: a.p_lane, action_type: a.p_type, connection_id: a.p_connection, provider: "microsoft_teams", target: structuredClone(a.p_target) as Record<string, unknown>, payload: structuredClone(a.p_payload) as Record<string, unknown>, payload_schema_version: a.p_version, payload_sha256: a.p_hash, rationale: null, source_refs: [], proposer_kind: "user", proposer_user_id: ME, derived_from_retrieved: false, supersedes_id: null, superseded_by_id: null, status: "proposed", expires_at: new Date(Date.now() + 3_600_000).toISOString(), approved_by: null, approved_at: null, approved_hash: null, executing_at: null, executed_at: null, verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        return { data: id, error: null };
      }
      case "act_get":
        return { data: [get(a.p_id)].filter(Boolean), error: null };
      case "act_approve": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (r.status === "approved") return err("act: already_approved");
        if (r.status !== "proposed") return err("act: not_pending");
        if (a.p_hash_seen !== r.payload_sha256) return err("act: hash_mismatch");
        Object.assign(r, { status: "approved", approved_by: ME, approved_at: new Date().toISOString(), approved_hash: r.payload_sha256 });
        return { data: r.payload_sha256, error: null };
      }
      case "act_claim_execution": {
        const r = get(a.p_id);
        if (!r) return err("act: not_found", "P0002");
        if (claims.has(r.id)) return err("act: already_claimed");
        if (r.status !== "approved") return err("act: not_approved");
        claims.set(r.id, { outcome: null, external_id: null });
        Object.assign(r, { status: "executing", executing_at: new Date().toISOString() });
        return { data: structuredClone(r), error: null };
      }
      case "act_claim_outcome":
        return { data: claims.get(a.p_id as string)?.outcome ?? null, error: null };
      case "act_claim_sent": {
        const c = claims.get(a.p_id as string);
        if (c) Object.assign(c, { outcome: "sent", external_id: a.p_external_id });
        return { data: null, error: null };
      }
      case "act_mark_verified": {
        const r = get(a.p_id);
        if (!r || r.status !== "executing") return err("act: not_executing");
        Object.assign(r, { status: "verified", result: { external_id: a.p_external_id } });
        delete r.payload.text;
        r.payload_purged_at = new Date().toISOString();
        return { data: null, error: null };
      }
      case "act_action_state": {
        const r = get(a.p_id);
        return { data: r ? [{ status: r.status, failure_code: r.failure_code ?? null }] : [], error: null };
      }
      default:
        return err("unknown function", "42883");
    }
  };
  return { rows, claims, rpc };
}

function setup() {
  const db = database();
  world.rpc = db.rpc;
  world.posts.length = 0;
  world.logged.length = 0;
  const client = laneClient();
  const routes = createTeamsRoutes({
    guards: async () => ({ requireLane: async () => ({ client, session: { userId: ME } }) as never, requireRole: async () => ({ client, session: { userId: ME } }) as never, requireStepUp: (async () => ({})) as never }),
    gate: async () => ({ limited: false, newsShown: true, visible: () => true }),
    rows: async () => [{ id: CONN, account: "robert@pubkgroup.com", state: "connected", mine: true, has: ["chat_read", "chat_send"] }] as never,
    // wired exactly as app/api/lanes/[laneId]/messages/send/route.ts wires it (a permissive limiter: the rate limit is not what is under test)
    send: { window: teamsStepUpWindow, run: sendTeamsMessage, failureText: teamsSendFailureText, limiter: createWindowLimiter(1000, 1000) },
  });
  const request = (clientRequestId: string, text = TEXT) =>
    routes.send(new Request("http://localhost:3000/api/lanes/PKG/messages/send", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ conn: CONN, chat: KEY, text, textSha256: teamsTextHash(text), clientRequestId }) }), "PKG");
  return { db, posts: world.posts, logged: world.logged, request };
}

beforeEach(() => {
  for (const f of Object.values(reader)) f.mockReset();
});

describe("the real send behind the real route (T-288 review D4)", () => {
  it("TWO OVERLAPPING REQUESTS WITH THE SAME REQUEST ID: one action, ONE POST, and every answer is truthful (never two 'sent' from two posts)", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.request(ID1), s.request(ID1)]);
    expect(s.posts).toHaveLength(1);
    expect(s.db.rows.size).toBe(1);
    expect(s.db.claims.size).toBe(1);
    const states = [(await a.json()).state, (await b.json()).state];
    expect(states).toContain("sent");
    expect(states.every((x) => ["sent", "checking", "unknown"].includes(x))).toBe(true);
    // a later replay of the same id and text, after the text was purged: still one POST, the settled state
    const again = await s.request(ID1);
    expect((await again.json()).state).toBe("sent");
    expect(s.posts).toHaveLength(1);
    expect([...s.db.rows.values()][0]?.payload.text).toBeUndefined();
  });

  it("the same id with other text is refused (request_reused), nothing is posted", async () => {
    const s = setup();
    await s.request(ID1);
    const r = await s.request(ID1, "something else entirely");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("request_reused");
    expect(s.posts).toHaveLength(1);
  });

  it("TWO DIFFERENT REQUEST IDS WITH THE SAME TEXT make TWO POSTS (accepted: two intended messages, e.g. from two tabs; the server cannot tell them from a person who sends 'ok' twice)", async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.request(ID1), s.request(ID2)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(s.posts).toHaveLength(2);
    expect(s.db.rows.size).toBe(2);
  });

  it("the text is in the one POST and nowhere else: not in an answer, an audit line, a stored row after the terminal state", async () => {
    const s = setup();
    const r = await s.request(ID1);
    expect(await r.clone().text()).not.toContain("CANARY");
    expect(s.posts.map((p) => p.text)).toEqual([TEXT]);
    expect(s.logged.join("\n")).not.toContain("CANARY");
    expect(JSON.stringify([...s.db.rows.values()])).not.toContain("CANARY");
  });
});
