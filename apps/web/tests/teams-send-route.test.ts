/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// T-288 (docs/specs/messages.md 10.3, 22.4, 22.8; spec 17 tests 10 - 13 at the route): `POST /api/lanes/<lane>/messages/send`. The approvals entry (`send.run`) is a fake here: its own rules (gates, hash,
// one POST, claim, text purge) are pinned in packages/modules/approvals (teams.test.ts, pgTAP). What the ROUTE owns is pinned here: the order of the checks, that each refusal happens before `run` is
// called (so nothing is proposed), the fixed codes, the Teams step-up window (from the server, never the request), `conn`'s denial cases, the rate limit, the answers' words, and that the text is
// nowhere but the call into `run`. Synthetic data only (rule 10).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@nichols/core/auth";
import { ApprovalsError, TeamsSendRefusal } from "@nichols/approvals/server";
import type { TeamsSendOutcome } from "@nichols/approvals/server";

const reader = vi.hoisted(() => ({ resolveCallTargets: vi.fn(), listMessages: vi.fn(), listChats: vi.fn(), openChat: vi.fn(), fetchHostedImage: vi.fn() }));
vi.mock("@nichols/connectors/teams-reader", () => ({ ...reader }));

import { createTeamsRoutes, type TeamsSendDeps } from "@/lib/teams-api";
import { encodeChatKey } from "@/lib/teams-chat-key";
import { createWindowLimiter } from "@/lib/teams-activity";

const ME = "00000000-0000-4000-8000-0000000000aa";
const A = "00000000-0000-4000-8000-0000000000c1";
const B = "00000000-0000-4000-8000-0000000000c2";
const OTHER_PERSON = "00000000-0000-4000-8000-0000000000d1";
const OTHER_LANE = "00000000-0000-4000-8000-0000000000e1";
const DISCONNECTED = "00000000-0000-4000-8000-0000000000d2";
const PENDING = "00000000-0000-4000-8000-0000000000d3";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const EXPIRED = "00000000-0000-4000-8000-0000000000d4";
const KEY = encodeChatKey("19:abc123def456@thread.v2");
const REQ = "5e11d0c0-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const CANARY = "CANARY-send-text-7f3a";
const row = (id: string, account: string, over: Record<string, unknown> = {}) => ({ id, account, state: "connected", mine: true, has: ["chat_read", "chat_send"], ...over });
const ROWS = [row(A, "robert@pubkgroup.com"), row(B, "robert@pub-k.org"), row(OTHER_PERSON, "x@pubkgroup.com", { mine: false }), row(DISCONNECTED, "old@pubkgroup.com", { state: "disconnected" }), row(EXPIRED, "e@pubkgroup.com", { state: "reconnect_required" })];

const everyReaderCall = () => Object.values(reader).flatMap((f) => f.mock.calls);
type Over = { stepUpThrows?: AuthError; roleThrows?: AuthError; laneThrows?: AuthError; visible?: boolean; run?: TeamsSendDeps["run"]; window?: number; limiter?: { take(key: string): number } };
function setup(over: Over = {}) {
  const order: string[] = [];
  const rpc: string[] = [];
  const client = { schema: () => ({ rpc: async (fn: string) => (rpc.push(fn), { data: null, error: null }) }) };
  const stepUp = vi.fn(async (...args: [age: number, opts?: unknown]) => {
    void args;
    order.push("stepUp");
    if (over.stepUpThrows) throw over.stepUpThrows;
    return {} as never;
  });
  const run = vi.fn<TeamsSendDeps["run"]>(over.run ?? (async () => ({ kind: "result", result: { status: "verified", actionId: "a1" } })));
  const routes = createTeamsRoutes({
    guards: async () => ({
      requireLane: async () => {
        order.push("lane");
        if (over.laneThrows) throw over.laneThrows;
        return { client, session: { userId: ME } } as never;
      },
      requireRole: async () => {
        order.push("role");
        if (over.roleThrows) throw over.roleThrows;
        return { client, session: { userId: ME } } as never;
      },
      requireStepUp: stepUp as never,
    }),
    gate: async () => (order.push("module"), { limited: false, newsShown: true, visible: () => over.visible !== false }),
    rows: async () => (order.push("rows"), ROWS as never),
    send: { window: async () => over.window ?? 28800, run, failureText: (c) => (c === "not_a_member" ? "You are not a member of this chat or channel, or sending is not allowed" : null), limiter: over.limiter ?? createWindowLimiter(100, 1000) },
  });
  return { routes, order, stepUp, run, rpc };
}
const SAME = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
const goodBody = (over: Record<string, unknown> = {}) => ({ conn: A, chat: KEY, text: CANARY, textSha256: HASH, clientRequestId: REQ, ...over });
const post = (body: unknown, headers: Record<string, string> = SAME, lane = "PKG") => ({
  request: new Request(`http://localhost:3000/api/lanes/${lane}/messages/send`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  lane,
});
const send = (s: ReturnType<typeof setup>, body: unknown, headers?: Record<string, string>, lane?: string) => {
  const p = post(body, headers, lane);
  return s.routes.send(p.request, p.lane);
};
const without = (k: string): Record<string, unknown> => Object.fromEntries(Object.entries(goodBody()).filter(([key]) => key !== k));
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logged.push(JSON.stringify(a)));
  for (const f of Object.values(reader)) f.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the order of the checks, each refusal before anything is proposed", () => {
  it("same site and Origin first: a cross-site request, a missing Origin and another origin are 403 with no guard run", async () => {
    for (const h of [{ origin: "https://evil.example.test", "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-origin" }, { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }, {}] as Record<string, string>[]) {
      const s = setup();
      expect((await send(s, goodBody(), h)).status).toBe(403);
      expect(s.order).toEqual([]);
      expect(s.run).not.toHaveBeenCalled();
    }
  });

  it("then the lane id shape (404 before any guard), then session/role (AAL2), then the step-up, then the module, then the connection", async () => {
    const bad = setup();
    expect((await send(bad, goodBody(), SAME, "pkg")).status).toBe(404);
    expect(bad.order).toEqual([]);
    const ok = setup();
    expect((await send(ok, goodBody())).status).toBe(200);
    expect(ok.order).toEqual(["lane", "role", "stepUp", "module", "rows"]);
    expect(ok.run).toHaveBeenCalledTimes(1);
  });

  it("no session is 401 and AAL1 is 403 mfa_required, before the step-up, the module and the connection", async () => {
    for (const [e, status, code] of [[new AuthError("no_session"), 401, "no_session"], [new AuthError("mfa_required"), 403, "mfa_required"]] as const) {
      const s = setup({ roleThrows: e });
      const r = await send(s, goodBody());
      expect([r.status, (await json(r)).error]).toEqual([status, code]);
      expect(s.order).toEqual(["lane", "role"]);
      expect(s.run).not.toHaveBeenCalled();
    }
  });

  it("a lane the person may not open is the same 404 as any other (no guard after it)", async () => {
    const s = setup({ laneThrows: new AuthError("forbidden") });
    expect((await send(s, goodBody())).status).toBe(404);
    expect(s.order).toEqual(["lane"]);
  });

  it("a stale authenticator code is 403 step_up_required BEFORE the module and the connection are looked at, with the typed text never read back", async () => {
    const s = setup({ stepUpThrows: new AuthError("step_up_required") });
    const r = await send(s, goodBody());
    expect([r.status, await json(r)]).toEqual([403, { error: "step_up_required" }]);
    expect(s.order).toEqual(["lane", "role", "stepUp"]); // no module read, no rows read
    expect(s.run).not.toHaveBeenCalled();
    expect(everyReaderCall()).toEqual([]);
  });

  it("the step-up window is the LANE's Teams window with the Teams bound, whatever the request says (a body field, a query string, a header)", async () => {
    for (const window of [300, 28800, 43200]) {
      const s = setup({ window });
      const p = post(goodBody());
      const req = new Request(`${p.request.url}?maxAge=30&window=1`, { method: "POST", headers: { ...Object.fromEntries(p.request.headers), "x-max-age": "30" }, body: JSON.stringify(goodBody()) });
      expect((await s.routes.send(req, "PKG")).status).toBe(200);
      expect(s.stepUp).toHaveBeenCalledWith(window, { window: "teams" });
    }
    const s = setup();
    expect((await send(s, goodBody({ maxAge: 30 }))).status).toBe(400); // an extra field is refused, not used
    expect(s.run).not.toHaveBeenCalled();
  });

  it("a company that hides Messages is 404 after the step-up and before the connection", async () => {
    const s = setup({ visible: false });
    expect((await send(s, goodBody())).status).toBe(404);
    expect(s.order).toEqual(["lane", "role", "stepUp", "module"]);
    expect(s.run).not.toHaveBeenCalled();
  });

  it("a body that is not JSON, not an object, empty or over 100 KB is 400 before any connection is looked at", async () => {
    for (const body of ["", "nope", "[1]", "null", JSON.stringify({ text: "x".repeat(100_001) })]) {
      const s = setup();
      expect((await send(s, body)).status, body.slice(0, 10)).toBe(400);
      expect(s.order).toEqual(["lane", "role", "stepUp", "module"]);
      expect(s.run).not.toHaveBeenCalled();
    }
  });
});

describe("conn: the caller's own usable Teams row in this lane, else the same answer, nothing proposed (spec 22.4)", () => {
  it("another person's id, another lane's id, a disconnected one, a pending one and an unknown uuid are the SAME 404 body with run never called and no Graph call", async () => {
    const s = setup();
    const bodies = new Set<string>();
    for (const conn of [OTHER_PERSON, OTHER_LANE, DISCONNECTED, PENDING, UNKNOWN]) {
      const r = await send(s, goodBody({ conn }));
      expect(r.status, conn).toBe(404);
      expect(r.headers.get("cache-control")).toContain("no-store");
      bodies.add(await r.text());
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "not_found" })]);
    expect(s.run).not.toHaveBeenCalled();
    expect(everyReaderCall()).toEqual([]);
  });

  it("a `conn` that is not a lower-case uuid, or is missing, is 400; the person's own expired sign-in is 409 reconnect; neither calls run", async () => {
    const s = setup();
    for (const conn of ["../x", "not-a-uuid", A.toUpperCase(), `${A}x`, "robert@pubkgroup.com", 7, null]) expect((await send(s, goodBody({ conn }))).status, String(conn)).toBe(400);
    expect((await send(s, without("conn"))).status).toBe(400);
    const r = await send(s, goodBody({ conn: EXPIRED }));
    expect([r.status, await json(r)]).toEqual([409, { error: "reconnect" }]);
    expect(s.run).not.toHaveBeenCalled();
  });

  it("SEVERAL ACCOUNTS: a send for the second account reaches run with that connection only (and the first with the first); the signed-in person and the chat id are the checked ones", async () => {
    const s = setup();
    expect((await send(s, goodBody({ conn: B, clientRequestId: "5e11d0c0-0000-4000-8000-000000000002" }))).status).toBe(200);
    expect(s.run.mock.calls.map((c) => c[1].connectionId)).toEqual([B]);
    expect(s.run.mock.calls[0]![0]).toMatchObject({ laneId: "PKG", userId: ME });
    expect(s.run.mock.calls[0]![1]).toMatchObject({ chatId: "19:abc123def456@thread.v2", clientRequestId: "5e11d0c0-0000-4000-8000-000000000002", textSha256: HASH });
    expect((await send(s, goodBody({ conn: A }))).status).toBe(200);
    expect(s.run.mock.calls.map((c) => c[1].connectionId)).toEqual([B, A]);
  });
});

describe("the body and the rate limit", () => {
  it("the body has exactly {conn, chat, text, textSha256, clientRequestId}: a missing, extra or mistyped field is 400 and run is not called", async () => {
    const full = goodBody();
    for (const [name, b] of [
      ["extra", { ...full, aiDrafted: true }],
      ["no text", without("text")],
      ["no hash", without("textSha256")],
      ["no request id", without("clientRequestId")],
      ["text number", { ...full, text: 5 }],
      ["hash number", { ...full, textSha256: 5 }],
      ["id number", { ...full, clientRequestId: 5 }],
      ["bad chat", { ...full, chat: "not a key" }],
      ["no chat", without("chat")],
    ] as const) {
      const s = setup();
      expect((await send(s, b)).status, name).toBe(400);
      expect(s.run, name).not.toHaveBeenCalled();
    }
  });

  it("ONE request per second per connection: a second press within the second is 429 and never reaches run; the other account is not held up; a later press is allowed", async () => {
    let t = 1_000_000;
    const s = setup({ limiter: createWindowLimiter(1, 1000, () => t) });
    expect((await send(s, goodBody())).status).toBe(200);
    const r = await send(s, goodBody());
    expect([r.status, (await json(r)).error, r.headers.get("retry-after")]).toEqual([429, "rate_limited", "1"]);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect((await send(s, goodBody({ conn: B }))).status).toBe(200);
    t += 1001;
    expect((await send(s, goodBody())).status).toBe(200);
    expect(s.run).toHaveBeenCalledTimes(3);
  });

  it("a repeated request with the SAME clientRequestId passes the SAME id to the approvals entry (which makes it one action and one POST: teams.test.ts TEST 11)", async () => {
    const s = setup();
    await send(s, goodBody());
    await send(s, goodBody());
    expect(s.run.mock.calls.map((c) => c[1].clientRequestId)).toEqual([REQ, REQ]);
  });
});

describe("what the approvals entry says, as the route's fixed answers (spec 17 test 13: the gate is named)", () => {
  const outcome = (o: TeamsSendOutcome) => setup({ run: async () => o });
  it("each gate is 409 `gate_<name>`", async () => {
    for (const gate of ["lane_off", "reconnect", "policy_off", "drafts_off", "not_live", "not_usable"] as const) {
      const r = await send(outcome({ kind: "gate", gate }), goodBody());
      expect([r.status, await json(r)]).toEqual([409, { error: `gate_${gate}` }]);
    }
  });

  it("the browser's hash differing from the server's is 400 text_mismatch", async () => {
    const r = await send(outcome({ kind: "text_mismatch" }), goodBody());
    expect([r.status, await json(r)]).toEqual([400, { error: "text_mismatch" }]);
  });

  it("the states: verified = sent; accepted but not read back, or in progress = checking; a definite refusal = not_sent with the fixed sentence; an unknown outcome = unknown", async () => {
    const st = async (result: { status: string; failureCode?: string; externalId?: string }) => json(await send(outcome({ kind: "result", result: { actionId: "a1", ...result } as never }), goodBody()));
    expect(await st({ status: "verified" })).toEqual({ ok: true, state: "sent" });
    expect(await st({ status: "sent_unverified" })).toEqual({ ok: true, state: "checking" });
    // T-288 review (security L1): approved but not claimed by this request is NEVER "Sent, checking": the first request may still be running or may have died
    expect(await st({ status: "already_in_progress" })).toEqual({ ok: true, state: "unknown" });
    expect(await st({ status: "verified", externalId: "1700000000001" })).toEqual({ ok: true, state: "sent", messageId: "1700000000001" });
    expect(await st({ status: "verified", externalId: "../x" })).toEqual({ ok: true, state: "sent" }); // an id that is not a message id is not handed on
    expect(await st({ status: "failed", failureCode: "not_a_member" })).toEqual({ ok: true, state: "not_sent", code: "not_a_member", message: "You are not a member of this chat or channel, or sending is not allowed", fresh: true }); // a definite failure is final: `fresh` says the next press needs a new id
    expect(await st({ status: "failed", failureCode: "throttled" })).toMatchObject({ state: "not_sent", code: "throttled" });
    for (const failureCode of ["outcome_unknown", "ambiguous_match", "verification_mismatch", "reconcile_connection_disconnected", "reconcile_sent_unverified"]) expect(await st({ status: "failed", failureCode }), failureCode).toMatchObject({ state: "unknown" });
    expect(await st({ status: "outcome_pending" })).toEqual({ ok: true, state: "unknown" });
  });

  it("an ApprovalsError is a fixed code: invalid text 400, role 403, not found 404, a reused request id 409, a gate the database closed 409, anything else 502 unknown_outcome", async () => {
    const e = (code: string) => setup({ run: async () => Promise.reject(new ApprovalsError(code as never)) });
    const got = async (code: string) => {
      const r = await send(e(code), goodBody());
      return [r.status, (await json(r)).error];
    };
    expect(await got("invalid")).toEqual([400, "invalid_message"]);
    expect(await got("forbidden")).toEqual([403, "forbidden"]);
    expect(await got("not_found")).toEqual([404, "not_found"]);
    expect(await got("request_reused")).toEqual([409, "request_reused"]);
    expect(await got("not_live")).toEqual([409, "gate_not_live"]);
    expect(await got("drafts_not_allowed")).toEqual([409, "gate_drafts_off"]);
    expect(await got("teams_not_enabled")).toEqual([409, "gate_not_enabled"]);
    // anything else after the approvals entry was called may have left a POST: an unknown outcome, never "not sent"
    expect(await got("unavailable")).toEqual([502, "unknown_outcome"]);
    expect(await got("hash_mismatch")).toEqual([502, "unknown_outcome"]);
    const boom = setup({ run: async () => Promise.reject(new Error("db down")) });
    const r = await send(boom, goodBody());
    expect([r.status, await json(r)]).toEqual([502, { error: "unknown_outcome" }]);
  });

  it("T-288 review B/D1: a refusal the approvals entry marks as before-anything-was-sent is a definite JSON answer that keeps the text; a rejected proposal says `fresh` (the next press needs a new id); a plain unavailable after the entry started stays unknown", async () => {
    const r1 = await send(setup({ run: async () => Promise.reject(new TeamsSendRefusal("unavailable", "before")) }), goodBody());
    expect([r1.status, await json(r1)]).toEqual([503, { error: "unavailable" }]);
    const r2 = await send(setup({ run: async () => Promise.reject(new TeamsSendRefusal("step_up_required", "rejected")) }), goodBody());
    expect([r2.status, await json(r2)]).toEqual([403, { error: "step_up_required", fresh: true }]);
    const r3 = await send(setup({ run: async () => Promise.reject(new TeamsSendRefusal("unavailable", "rejected")) }), goodBody());
    expect([r3.status, await json(r3)]).toEqual([503, { error: "unavailable", fresh: true }]);
    const r4 = await send(setup({ run: async () => Promise.reject(new ApprovalsError("unavailable")) }), goodBody());
    expect([r4.status, await json(r4)]).toEqual([502, { error: "unknown_outcome" }]);
  });

  it("without the send wiring the route is 503 and nothing runs", async () => {
    const routes = createTeamsRoutes({ guards: async () => ({}) as never });
    const p = post(goodBody());
    expect((await routes.send(p.request, p.lane)).status).toBe(503);
  });
});

describe("the message text is nowhere but the call into the approvals entry (rule 6, spec 17 test 8)", () => {
  it("not in any answer, log line, or error on success, every failure, a refusal and an exception whose own message holds the text", async () => {
    const cases: [string, Over][] = [
      ["ok", {}],
      ["failed", { run: async () => ({ kind: "result", result: { status: "failed", actionId: "a", failureCode: "not_a_member" } }) }],
      ["unknown", { run: async () => ({ kind: "result", result: { status: "outcome_pending", actionId: "a" } }) }],
      ["gate", { run: async () => ({ kind: "gate", gate: "not_live" }) }],
      ["mismatch", { run: async () => ({ kind: "text_mismatch" }) }],
      ["invalid", { run: async () => Promise.reject(new ApprovalsError("invalid", `bad text ${CANARY}`)) }],
      ["throws", { run: async () => Promise.reject(new Error(`boom ${CANARY}`)) }],
      ["step-up", { stepUpThrows: new AuthError("step_up_required") }],
    ];
    for (const [name, over] of cases) {
      const s = setup(over);
      const r = await send(s, goodBody());
      expect(await r.text(), name).not.toContain("CANARY");
      expect(r.headers.get("cache-control"), name).toContain("no-store");
    }
    expect(logged.join("\n")).not.toContain("CANARY");
  });

  it("the text reaches run exactly as typed (the approvals entry normalises it), once per request", async () => {
    const s = setup();
    await send(s, goodBody({ text: `  ${CANARY}\r\nline two  ` }));
    expect(s.run.mock.calls[0]![1].text).toBe(`  ${CANARY}\r\nline two  `);
  });
});
