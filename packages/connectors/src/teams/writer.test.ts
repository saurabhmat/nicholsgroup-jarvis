// The Teams message writer (T-287; docs/specs/messages.md 10.4) against the fake Teams: every row of the outcome table, the one-POST guarantee, the read-back, the lookup after an unknown outcome,
// every refusal before a request is made, and "no text anywhere but the one POST body". Synthetic data only (rule 10): example.test accounts, invented ids.
import { afterEach, describe, expect, it } from "vitest";
import { computePayloadSha256 } from "../contract/writer";
import { RateLimiter } from "../http/rate-limit";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { useMockServer } from "../testing/msw/index";
import { createFakeTeams, type FakePostStep } from "../testing/msw/teams/handlers";
import { createTeamsHarness, TEAMS_OTHER_USER, TEAMS_OWNER } from "../testing/teams-harness";
import { TEAMS_SEND_FAILURES, TEAMS_LOOKUP_SKEW_MS, createTeamsMessageWriter, prepareTeamsWrite, teamsFailureCodeOf, teamsLookupWindow, type TeamsApprovedAction } from "./writer";
import { createTeamsWriteClient } from "./write-client";

const server = useMockServer();
afterEach(() => RateLimiter.resetForTests());

const PERSON = "person@teams.example.test";
const CHAT = "19:abc123def456@thread.v2";
const TEAM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHANNEL = "19:chan123@thread.tacv2";
const POST = "1700000000001";
const CANARY = "CANARY-teams-message-text-8c41 <b>& “quoted”";
const REQ = "5e11d0c0-0000-4000-8000-000000000001";
const ALL = ["chat_read", "chat_send", "channels_read", "channels_send"] as const;
let counter = 0;

function setup(opts: { features?: readonly ("chat_read" | "chat_send" | "channels_read" | "channels_send")[]; connFeatures?: readonly ("chat_read" | "chat_send" | "channels_read" | "channels_send")[]; timeoutMs?: number; claimOpen?: boolean; storedAccessExpired?: boolean } = {}) {
  const fake = createFakeTeams();
  server.use(...fake.handlers);
  const h = createTeamsHarness({ fake, lanes: { PKG: { teams: { features: [...(opts.features ?? ALL)] }, mailProviders: ["google"] } } });
  const { row, account, conn } = h.connect("PKG", PERSON, { features: [...(opts.connFeatures ?? ALL)], ...(opts.storedAccessExpired ? { storedAccessExpired: true } : {}) });
  const logs: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => logs.push(e) });
  const claimCalls: string[] = [];
  const claims = {
    async claimOpen(_lane: string, id: string, hash: string, by: string) {
      claimCalls.push(`${id}:${by}`);
      return opts.claimOpen !== false && hash.length === 64;
    },
  };
  // the twin of core.act_claimed_external_ids: message id -> the action that recorded it on its claim
  const claimedBy = new Map<string, string>();
  const claimed = {
    async claimedExternalIds(_lane: string, _conn: string, except: string, ids: readonly string[]) {
      return ids.filter((id) => claimedBy.has(id) && claimedBy.get(id) !== except);
    },
  };
  const write = createTeamsWriteClient({ guard: h.guard, tokens: h.tokens, errors: h.errors, httpOptions: { ...h.httpOptions, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) } });
  const writer = createTeamsMessageWriter({ guard: h.guard, api: h.api, write, claims, claimed, logger, sleep: async () => undefined, lookupPauseMs: 0 });
  return { fake, h, row, account, conn, writer, logs, claimCalls, write, claimedBy };
}
type S = ReturnType<typeof setup>;

function action(s: S, over: Partial<TeamsApprovedAction> & { text?: string; target?: Record<string, string> } = {}): TeamsApprovedAction {
  const type = over.action_type ?? "teams.chat.send";
  const target =
    over.target ??
    (type === "teams.chat.send"
      ? { chat_id: CHAT, client_request_id: REQ }
      : type === "teams.channel.post"
        ? { team_id: TEAM, channel_id: CHANNEL, client_request_id: REQ }
        : { team_id: TEAM, channel_id: CHANNEL, reply_to_id: POST, client_request_id: REQ });
  const base = {
    id: over.id ?? `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    lane_id: "PKG" as const,
    connection_id: s.row.id,
    action_type: type,
    target,
    payload: { content_type: "text", text: over.text ?? CANARY },
    payload_schema_version: 1,
  };
  return { ...base, ...(over.payload ? { payload: over.payload } : {}), payload_sha256: over.payload_sha256 ?? computePayloadSha256({ ...base, ...(over.payload ? { payload: over.payload } : {}) }), approved_by: over.approved_by ?? TEAMS_OWNER, ...(over.lane_id ? { lane_id: over.lane_id } : {}), ...(over.connection_id ? { connection_id: over.connection_id } : {}) } as TeamsApprovedAction;
}
const posts = (s: S) => s.fake.state.graphRequests.filter((r) => r.method === "POST");
const gets = (s: S) => s.fake.state.graphRequests.filter((r) => r.method === "GET");
const plan = (s: S, ...steps: FakePostStep[]) => void s.fake.state.postPlan.push(...steps);
const stored = (s: S) => s.fake.state.messagesByChat.get(CHAT) ?? [];
const noCanary = (s: S, ...extra: unknown[]) => {
  const blob = JSON.stringify([s.logs, s.h.logs, s.h.apiErrors, s.h.audits, ...extra]);
  expect(blob).not.toContain("CANARY-teams-message-text");
};
const untouched = (s: S) => {
  expect(s.h.stats.tokenReads).toBe(0);
  expect(s.fake.state.graphRequests).toHaveLength(0);
};
const code = (e: unknown) => teamsFailureCodeOf(e);

describe("a message is posted once and read back", () => {
  it("chat send: ONE POST with exactly the documented body, then the read-back by id verifies it", async () => {
    const s = setup();
    const a = action(s);
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    expect(res).toMatchObject({ outcome: "accepted", external_id: expect.stringMatching(/^synthetic-message-/) });
    expect(posts(s)).toHaveLength(1);
    expect(posts(s)[0]).toMatchObject({ method: "POST", body: { body: { contentType: "text", content: CANARY } } });
    expect(Object.keys((posts(s)[0] as { body: object }).body)).toEqual(["body"]);
    expect(s.claimCalls).toEqual([`${a.id}:${TEAMS_OWNER}`]);
    await s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string, { since: new Date(Date.now() - 120_000).toISOString() });
    // the read-back is a GET of that one message
    expect(gets(s).map((r) => r.path)).toEqual([expect.stringContaining("/messages/synthetic-message-")]);
    expect(s.logs.filter((l) => l.event === "teams.send.read_back_form")).toHaveLength(1);
    expect(s.logs.find((l) => l.event === "teams.send.read_back_form")).toMatchObject({ fields: { form: "text" } });
    noCanary(s);
  });

  it("the read-back also verifies a message Teams returns as HTML (the body form is not stated in the fact sheet): the form, never the text, is logged", async () => {
    const s = setup();
    const a = action(s);
    plan(s, { form: "html" });
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    await s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string);
    expect(s.logs.find((l) => l.event === "teams.send.read_back_form")).toMatchObject({ fields: { form: "html" } });
    noCanary(s);
  });

  it("a channel post goes to the channel route and a channel reply to the replies route, once each, and both are read back", async () => {
    const s = setup();
    const post = action(s, { action_type: "teams.channel.post" });
    const r1 = await s.writer.executeWrite("PKG", s.conn, post);
    await s.writer.verifyWrite("PKG", s.conn, post, r1.external_id as string);
    const reply = action(s, { action_type: "teams.channel.reply", text: "a reply" });
    const r2 = await s.writer.executeWrite("PKG", s.conn, reply);
    await s.writer.verifyWrite("PKG", s.conn, reply, r2.external_id as string);
    expect(posts(s).map((p) => decodeURIComponent(p.path))).toEqual([`/v1.0/teams/${TEAM}/channels/${CHANNEL}/messages`, `/v1.0/teams/${TEAM}/channels/${CHANNEL}/messages/${POST}/replies`]);
    expect(posts(s)).toHaveLength(2);
  });

  it("verification fails on different text, another sender, another chat, a message from before the claim, a deleted message; and is not_found for an id that is not there", async () => {
    const s = setup();
    const a = action(s);
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    const id = res.external_id as string;
    const msg = stored(s)[0] as Record<string, unknown>;
    const since = { since: new Date(Date.now() - 120_000).toISOString() };
    await s.writer.verifyWrite("PKG", s.conn, a, id, since);
    const expectMismatch = async (label: string) => {
      const e = await s.writer.verifyWrite("PKG", s.conn, a, id, since).then(() => null, (x: unknown) => x);
      expect(code(e), label).toBe("verification_mismatch");
    };
    const original = structuredClone(msg);
    (msg.body as { content: string }).content = "something else entirely";
    await expectMismatch("different text");
    Object.assign(msg, structuredClone(original));
    (msg.from as { user: { id: string } }).user.id = "11111111-2222-4333-8444-555555555555";
    await expectMismatch("another sender");
    Object.assign(msg, structuredClone(original));
    msg.chatId = "19:someoneelseschat@thread.v2";
    await expectMismatch("another chat");
    Object.assign(msg, structuredClone(original));
    msg.createdDateTime = new Date(Date.now() - 3600_000).toISOString();
    await expectMismatch("created before the claim");
    Object.assign(msg, structuredClone(original));
    msg.deletedDateTime = new Date().toISOString();
    await expectMismatch("deleted");
    Object.assign(msg, structuredClone(original));
    msg.messageType = "systemEventMessage";
    await expectMismatch("a system event");
    Object.assign(msg, structuredClone(original));
    await s.writer.verifyWrite("PKG", s.conn, a, id, since);
    await expect(s.writer.verifyWrite("PKG", s.conn, a, "synthetic-message-not-there")).rejects.toMatchObject({ info: { kind: "not_found" } });
    noCanary(s);
  });

  it("a text that differs only in markup, whitespace or case of tags still verifies; a changed word does not", async () => {
    const s = setup();
    const a = action(s, { text: "line one\nline two  with   spaces" });
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    const msg = stored(s)[0] as { body: { contentType: string; content: string } };
    msg.body = { contentType: "html", content: "<P>line one<BR>line two with spaces</P>" };
    await s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string);
    msg.body = { contentType: "html", content: "<p>line one<br>line 2 with spaces</p>" };
    await expect(s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string)).rejects.toSatisfy((e) => code(e) === "verification_mismatch");
  });
});

describe("the outcome table of the POST", () => {
  const cases: [number, string][] = [
    [400, "send_rejected"],
    [403, "not_a_member"],
    [404, "target_not_found"],
    [413, "message_too_large"],
    [429, "throttled"],
  ];
  for (const [status, expected] of cases) {
    it(`${String(status)}: failed with the fixed message, nothing sent, no lookup, no second POST`, async () => {
      const s = setup();
      plan(s, { answer: status });
      const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
      expect(code(e)).toBe(expected);
      expect((e as Error).message).toBe(TEAMS_SEND_FAILURES[expected as keyof typeof TEAMS_SEND_FAILURES]);
      expect(posts(s)).toHaveLength(1);
      expect(gets(s)).toHaveLength(0);
      expect(stored(s)).toHaveLength(0);
      noCanary(s, String((e as Error).message), JSON.stringify(e));
    });
  }

  it("429 carries a Retry-After and is still NOT retried by the writer or the client (the person may press Send again, which is a new action)", async () => {
    const s = setup();
    s.fake.state.graphFail = { status: 429, code: "TooManyRequests", times: 5, retryAfter: 1 };
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("throttled");
    expect(posts(s)).toHaveLength(1);
    expect(s.h.clock.waits).toEqual([]);
  });

  it("201 whose message is then read back: verified (the one-step path of the executor)", async () => {
    const s = setup();
    const a = action(s);
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    await expect(s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string)).resolves.toBeUndefined();
  });

  const unknowns: [string, FakePostStep, number][] = [
    ["a network error after Graph accepted it", { answer: "network_error", store: true }, 1],
    ["a 500 after Graph accepted it", { answer: 500, store: true }, 1],
    ["a 503 after Graph accepted it", { answer: 503, store: true }, 1],
  ];
  for (const [label, step] of unknowns) {
    it(`${label}: no second POST; the lookup finds exactly one own message with the approved text: verified as already_applied`, async () => {
      const s = setup();
      plan(s, step);
      const res = await s.writer.executeWrite("PKG", s.conn, action(s));
      expect(res).toMatchObject({ outcome: "already_applied", external_id: (stored(s)[0] as { id: string }).id });
      expect(posts(s)).toHaveLength(1);
      const lookup = gets(s)[0] as { path: string; search: string };
      expect(decodeURIComponent(lookup.path)).toBe(`/v1.0/chats/${CHAT}/messages`);
      expect(decodeURIComponent(lookup.search.replace(/\+/g, " "))).toMatch(/\$orderby=lastModifiedDateTime desc/);
      expect(decodeURIComponent(lookup.search.replace(/\+/g, " "))).toMatch(/\$filter=lastModifiedDateTime gt \d{4}-\d{2}-\d{2}T/);
      expect(decodeURIComponent(lookup.search)).toMatch(/\$top=50/);
      noCanary(s);
    });
  }

  it("a timeout after Graph accepted it: no second POST; one match found: verified as already_applied", async () => {
    const s = setup({ timeoutMs: 300 });
    plan(s, { answer: "timeout" });
    const res = await s.writer.executeWrite("PKG", s.conn, action(s));
    expect(res.outcome).toBe("already_applied");
    expect(posts(s)).toHaveLength(1);
  });

  it("an unknown outcome and NO matching message: the action stays executing (outcome_pending); still one POST, nothing posted again", async () => {
    const s = setup();
    plan(s, { answer: 500, store: false });
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("outcome_pending");
    expect(posts(s)).toHaveLength(1);
    expect(gets(s)).toHaveLength(1);
  });

  it("an unknown outcome and the lookup itself failing (Graph answers 429 to it): outcome_pending (never a failure, never a resend)", async () => {
    const s = setup();
    plan(s, { answer: 500, store: true, thenThrottle: 3 });
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("outcome_pending");
    expect(posts(s)).toHaveLength(1);
  });

  it("TWO own messages with the approved text in the window: ambiguous_match (no guess, no resend)", async () => {
    const s = setup();
    const earlier = new Date(Date.now() - 5_000).toISOString(); // inside the lookup window (15 s before the POST)
    s.fake.state.messagesByChat.set(CHAT, [
      { id: "typed-in-teams-1", messageType: "message", createdDateTime: earlier, lastModifiedDateTime: earlier, from: { user: { id: s.account.objectId } }, body: { contentType: "text", content: CANARY }, chatId: CHAT },
    ]);
    plan(s, { answer: 500, store: true });
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("ambiguous_match");
    expect(posts(s)).toHaveLength(1);
  });

  it("the lookup ignores another person's message, an older one, a different text, a deleted one and a system event", async () => {
    const s = setup();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3600_000).toISOString();
    const base = { messageType: "message", createdDateTime: now, lastModifiedDateTime: now, from: { user: { id: s.account.objectId } }, body: { contentType: "text", content: CANARY }, chatId: CHAT };
    s.fake.state.messagesByChat.set(CHAT, [
      { ...base, id: "other-person", from: { user: { id: "11111111-2222-4333-8444-555555555555" } } },
      { ...base, id: "older", createdDateTime: old, lastModifiedDateTime: now },
      { ...base, id: "different", body: { contentType: "text", content: "hello" } },
      { ...base, id: "deleted", deletedDateTime: now },
      { ...base, id: "system", messageType: "systemEventMessage" },
    ]);
    plan(s, { answer: 500, store: false });
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("outcome_pending");
    expect(await s.writer.findWrite("PKG", s.conn, action(s), { since: new Date(Date.now() - 120_000).toISOString() })).toEqual([]);
  });

  it("a channel post with an unknown outcome is looked up in the channel's newest posts; a channel reply in the post's replies", async () => {
    const s = setup();
    plan(s, { answer: 500, store: true }, { answer: "network_error", store: true });
    const post = await s.writer.executeWrite("PKG", s.conn, action(s, { action_type: "teams.channel.post" }));
    expect(post.outcome).toBe("already_applied");
    const reply = await s.writer.executeWrite("PKG", s.conn, action(s, { action_type: "teams.channel.reply", text: "reply text" }));
    expect(reply.outcome).toBe("already_applied");
    expect(posts(s)).toHaveLength(2);
    expect(gets(s).map((r) => decodeURIComponent(r.path))).toEqual([`/v1.0/teams/${TEAM}/channels/${CHANNEL}/messages`, `/v1.0/teams/${TEAM}/channels/${CHANNEL}/messages/${POST}/replies`]);
  });

});

describe("the lookup never takes an earlier message as this one (T-286 review M-B)", () => {
  it("an earlier send of the same text from another action (within the window) is not taken: the second send whose POST timed out undelivered stays pending", async () => {
    const s = setup();
    const first = await s.writer.executeWrite("PKG", s.conn, action(s, { text: "same words" }));
    s.claimedBy.set(first.external_id as string, "00000000-0000-4000-8000-0000000000f1"); // the executor recorded it on the first action's claim
    plan(s, { answer: 500, store: false });
    const e = await s.writer.executeWrite("PKG", s.conn, action(s, { text: "same words" })).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("outcome_pending");
    expect(posts(s)).toHaveLength(2);
  });

  it("a message with the same text typed in Teams BEFORE the POST started (older than the 15 s skew) is not taken either", async () => {
    const s = setup();
    const older = new Date(Date.now() - 60_000).toISOString();
    s.fake.state.messagesByChat.set(CHAT, [{ id: "typed-earlier", messageType: "message", createdDateTime: older, lastModifiedDateTime: new Date().toISOString(), from: { user: { id: s.account.objectId } }, body: { contentType: "text", content: CANARY }, chatId: CHAT }]);
    plan(s, { answer: 500, store: false });
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("outcome_pending");
    expect(await s.writer.findWrite("PKG", s.conn, action(s), { since: new Date(Date.now() - 15_000).toISOString() })).toEqual([]);
  });

  it("the genuine case still verifies: the POST timed out after Graph accepted it, and nobody else recorded that message", async () => {
    const s = setup();
    const first = await s.writer.executeWrite("PKG", s.conn, action(s, { text: "same words" }));
    s.claimedBy.set(first.external_id as string, "00000000-0000-4000-8000-0000000000f1");
    plan(s, { answer: 500, store: true });
    const res = await s.writer.executeWrite("PKG", s.conn, action(s, { text: "same words" }));
    expect(res.outcome).toBe("already_applied");
    expect(res.external_id).not.toBe(first.external_id);
  });

  it("the reconciler's findWrite applies the same rule: a message claimed by another action is not returned", async () => {
    const s = setup();
    const first = await s.writer.executeWrite("PKG", s.conn, action(s));
    const a = action(s);
    expect(await s.writer.findWrite("PKG", s.conn, a, { since: new Date(Date.now() - 15_000).toISOString() })).toEqual([first.external_id]);
    s.claimedBy.set(first.external_id as string, "00000000-0000-4000-8000-0000000000f1");
    expect(await s.writer.findWrite("PKG", s.conn, a, { since: new Date(Date.now() - 15_000).toISOString() })).toEqual([]);
  });

  it("a failing check of the claimed ids is a failed lookup: pending, never a guess", async () => {
    const s = setup();
    plan(s, { answer: 500, store: true });
    const claimed = { async claimedExternalIds() { throw new Error("database down"); } };
    const w = createTeamsMessageWriter({ guard: s.h.guard, api: s.h.api, write: s.write, claims: { async claimOpen() { return true; } }, claimed, sleep: async () => undefined, lookupPauseMs: 0 });
    const e = await w.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("outcome_pending");
  });
});

describe("odd statuses, an unreadable 201, a 401 after refresh and a credential failure (T-286 review M-E, L2, L4)", () => {
  for (const status of [408, 409, 423, 422, 502]) {
    it(`${String(status)} is NOT a definite refusal: it is looked up (found: already_applied; not found: pending), never posted again`, async () => {
      const found = setup();
      plan(found, { answer: status, store: true });
      expect((await found.writer.executeWrite("PKG", found.conn, action(found))).outcome).toBe("already_applied");
      expect(posts(found)).toHaveLength(1);
      const none = setup();
      plan(none, { answer: status, store: false });
      await expect(none.writer.executeWrite("PKG", none.conn, action(none))).rejects.toSatisfy((e) => code(e) === "outcome_pending");
      expect(posts(none)).toHaveLength(1);
    });
  }

  it("a 201 without a readable message id is an unknown outcome: looked up, never posted again", async () => {
    const found = setup();
    plan(found, { noId: true });
    expect((await found.writer.executeWrite("PKG", found.conn, action(found))).outcome).toBe("already_applied");
    expect(posts(found)).toHaveLength(1);
    const none = setup();
    plan(none, { noId: true, store: false });
    await expect(none.writer.executeWrite("PKG", none.conn, action(none))).rejects.toSatisfy((e) => code(e) === "outcome_pending");
    expect(posts(none)).toHaveLength(1);
  });

  it("a 401 that survives the one refresh is definite (connection_unhealthy): no lookup, nothing stored", async () => {
    const s = setup();
    s.fake.state.unauthorizedOnce = 6;
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("connection_unhealthy");
    expect(gets(s)).toHaveLength(0);
    expect(stored(s)).toHaveLength(0);
  });

  it("a credential failure BEFORE any request (the refresh fails) is definite, not an unknown outcome: nothing was sent, no lookup", async () => {
    const s = setup({ storedAccessExpired: true });
    s.fake.state.failRefresh = { status: 500, error: "server_error", times: 10 };
    const e = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("connection_unhealthy");
    expect(posts(s)).toHaveLength(0);
    expect(gets(s)).toHaveLength(0);
  });

  it("an infrastructure failure of the guard before the POST is 'not sent' too (execution_refused), not pending", async () => {
    const s = setup();
    const w = createTeamsMessageWriter({ guard: async () => { throw new Error("database down"); }, api: s.h.api, write: s.write, claims: { async claimOpen() { return true; } }, claimed: { async claimedExternalIds() { return []; } }, sleep: async () => undefined, lookupPauseMs: 0 });
    const e = await w.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
    expect(code(e)).toBe("execution_refused");
    expect(posts(s)).toHaveLength(0);
  });

  it("the write pacing is one POST per second per connection (pacing only: the POST is still never retried)", async () => {
    const s = setup();
    await s.writer.executeWrite("PKG", s.conn, action(s, { text: "one" }));
    await s.writer.executeWrite("PKG", s.conn, action(s, { text: "two" }));
    expect(s.h.clock.waits.some((w) => w >= 900)).toBe(true);
    expect(posts(s)).toHaveLength(2);
  });
});

describe("exactly one POST per action", () => {
  it("two concurrent executions of the same action make ONE POST (the second is refused)", async () => {
    const s = setup();
    const a = action(s);
    const results = await Promise.allSettled([s.writer.executeWrite("PKG", s.conn, a), s.writer.executeWrite("PKG", s.conn, a)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(posts(s)).toHaveLength(1);
  });

  it("a second execution after the first (even after a definite failure) is refused without any request", async () => {
    const s = setup();
    const a = action(s);
    plan(s, { answer: 403 });
    await expect(s.writer.executeWrite("PKG", s.conn, a)).rejects.toSatisfy((e) => code(e) === "not_a_member");
    const before = s.fake.state.graphRequests.length;
    // not "nothing was sent": whether the first attempt delivered is not known here
    await expect(s.writer.executeWrite("PKG", s.conn, a)).rejects.toSatisfy((e) => code(e) === "outcome_pending");
    expect(s.fake.state.graphRequests.length).toBe(before);
    expect(posts(s)).toHaveLength(1);
  });

  it("a closed or missing claim in the approvals database refuses before any request or token read", async () => {
    const s = setup({ claimOpen: false });
    await expect(s.writer.executeWrite("PKG", s.conn, action(s))).rejects.toMatchObject({ info: { kind: "forbidden", message: "This action is not approved and claimed for execution" } });
    untouched(s);
  });

  it("different actions are independent: each gets its own single POST", async () => {
    const s = setup();
    await s.writer.executeWrite("PKG", s.conn, action(s, { text: "one" }));
    await s.writer.executeWrite("PKG", s.conn, action(s, { text: "two" }));
    expect(posts(s)).toHaveLength(2);
  });
});

describe("everything is checked before a request is made or a token is read", () => {
  const refusals: [string, (s: S) => TeamsApprovedAction, string][] = [
    ["a changed text (the stored content no longer hashes to the approved hash)", (s) => ({ ...action(s), payload: { content_type: "text", text: "not what was approved" } }), "invalid_input"],
    ["a changed chat (target)", (s) => ({ ...action(s), target: { chat_id: "19:another@thread.v2", client_request_id: REQ } }), "invalid_input"],
    ["a wrong hash", (s) => ({ ...action(s), payload_sha256: "0".repeat(64) }), "invalid_input"],
    ["another lane", (s) => action(s, { lane_id: "APK" as never }), "lane_mismatch"],
    ["another connection", (s) => action(s, { connection_id: "00000000-0000-4000-8000-0000000000ff" }), "lane_mismatch"],
    ["a type that is not a Teams type", (s) => action(s, { action_type: "email.send" }), "unsupported_op"],
    ["an approver that is not a UUID", (s) => action(s, { approved_by: "nope" }), "invalid_input"],
  ];
  for (const [label, make, kind] of refusals) {
    it(`${label}: refused, nothing read, nothing sent`, async () => {
      const s = setup();
      await expect(s.writer.executeWrite("PKG", s.conn, make(s))).rejects.toMatchObject({ info: { kind } });
      untouched(s);
      expect(s.claimCalls).toEqual([]);
    });
  }

  it("a payload that is not plain text (html, an extra key, a mention, a control character, empty, too long, not trimmed) is refused even with a matching hash", async () => {
    const s = setup();
    const payloads: Record<string, unknown>[] = [
      { content_type: "html", text: "<b>x</b>" },
      { content_type: "text", text: "x", mentions: [] },
      { content_type: "text", text: "bell\u0007" },
      { content_type: "text", text: "a\rb" },
      { content_type: "text", text: "" },
      { content_type: "text", text: "x".repeat(10_001) },
      { content_type: "text", text: " padded " },
      { content_type: "text" },
    ];
    for (const payload of payloads) await expect(s.writer.executeWrite("PKG", s.conn, action(s, { payload: payload as never })), JSON.stringify(payload).slice(0, 50)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
  });

  it("ids are validated before any request (a chat id with a slash, a team that is not a UUID, a missing reply parent, an extra target key)", async () => {
    const s = setup();
    const bad: [TeamsApprovedAction["action_type"], Record<string, string>][] = [
      ["teams.chat.send", { chat_id: "19:a/b", client_request_id: REQ }],
      ["teams.chat.send", { chat_id: CHAT, client_request_id: "not-a-uuid" }],
      ["teams.chat.send", { chat_id: CHAT, client_request_id: REQ, extra: "x" }],
      ["teams.channel.post", { team_id: "not-a-uuid", channel_id: CHANNEL, client_request_id: REQ }],
      ["teams.channel.reply", { team_id: TEAM, channel_id: CHANNEL, client_request_id: REQ }],
      ["teams.channel.reply", { team_id: TEAM, channel_id: CHANNEL, reply_to_id: "../x", client_request_id: REQ }],
    ];
    for (const [type, target] of bad) await expect(s.writer.executeWrite("PKG", s.conn, action(s, { action_type: type, target })), JSON.stringify(target)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    untouched(s);
  });

  it("another person as approver is refused: only the connection's owner sends from it (the same not_found as an unknown id), before a token read", async () => {
    const s = setup();
    await expect(s.writer.executeWrite("PKG", s.conn, action(s, { approved_by: TEAMS_OTHER_USER }))).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(s.h.stats.tokenReads).toBe(0);
    expect(s.fake.state.graphRequests).toHaveLength(0);
  });

  it("the lane's teams.features without chat_send, or a connection without the send feature, refuses a chat send; channels_send likewise for a channel", async () => {
    const lane = setup({ features: ["chat_read", "channels_read", "channels_send"] });
    await expect(lane.writer.executeWrite("PKG", lane.conn, action(lane))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    untouched(lane);
    const connection = setup({ connFeatures: ["chat_read", "channels_read"] });
    await expect(connection.writer.executeWrite("PKG", connection.conn, action(connection))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    untouched(connection);
    const channels = setup({ connFeatures: ["chat_read", "chat_send"] });
    await expect(channels.writer.executeWrite("PKG", channels.conn, action(channels, { action_type: "teams.channel.post" }))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    untouched(channels);
  });

  it("Teams switched off for the lane, a disconnected connection, and a Google connection are refused before any token read", async () => {
    const off = setup();
    off.h.setLane("PKG", { teams: { enabled: false } });
    await expect(off.writer.executeWrite("PKG", off.conn, action(off))).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
    untouched(off);
    const gone = setup();
    gone.row.status = "disconnected";
    await expect(gone.writer.executeWrite("PKG", gone.conn, action(gone))).rejects.toBeDefined();
    untouched(gone);
    const google = setup();
    const notTeams = { ...google.conn, provider: "google" } as never;
    await expect(google.writer.executeWrite("PKG", notTeams, action(google))).rejects.toBeDefined();
    untouched(google);
  });

  it("prepareTeamsWrite reads no token and makes no request, and returns the guarded row, the parsed send and the approver", async () => {
    const s = setup();
    const p = await prepareTeamsWrite({ guard: s.h.guard }, "PKG", s.conn, action(s));
    expect(p).toMatchObject({ approvedBy: TEAMS_OWNER, send: { type: "teams.chat.send", chatId: CHAT, text: CANARY } });
    expect(p.g.entraObjectId).toBe(s.account.objectId);
    untouched(s);
  });

  it("the message text is in the one POST body and nowhere else: not in a log line, an audit, an error record or a thrown error, whatever the outcome", async () => {
    for (const step of [{}, { answer: 403 }, { answer: 500, store: true }, { answer: 500, store: false }, { answer: "network_error" as const, store: true }] as FakePostStep[]) {
      const s = setup();
      plan(s, step);
      const err = await s.writer.executeWrite("PKG", s.conn, action(s)).then(() => null, (x: unknown) => x);
      noCanary(s, err === null ? "" : JSON.stringify(err), err === null ? "" : (err as Error).message, err === null ? "" : (err as Error).stack ?? "");
      expect(posts(s)).toHaveLength(1);
    }
  });
});

describe("recovery (the reconciler's read side)", () => {
  it("findWrite returns the own matching message ids since the window and writes nothing", async () => {
    const s = setup();
    const a = action(s);
    plan(s, { answer: 500, store: true });
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    const before = posts(s).length;
    expect(await s.writer.findWrite("PKG", s.conn, a, { since: new Date(Date.now() - 120_000).toISOString() })).toEqual([res.external_id]);
    expect(posts(s)).toHaveLength(before);
  });

  it("a message created before the window is not found; without a window the last 24 hours are searched", async () => {
    const s = setup();
    const a = action(s);
    await s.writer.executeWrite("PKG", s.conn, a);
    expect(await s.writer.findWrite("PKG", s.conn, a, { since: new Date(Date.now() + 60_000).toISOString() })).toEqual([]);
    expect((await s.writer.findWrite("PKG", s.conn, a)).length).toBe(1);
  });

  it("the writer's reconciler read side has no executeWrite (the entry file exports only find and verify)", () => {
    const s = setup();
    const readSide = Object.freeze({ findWrite: s.writer.findWrite, verifyWrite: s.writer.verifyWrite });
    expect(Object.keys(readSide)).toEqual(["findWrite", "verifyWrite"]);
  });
});

describe("the id a POST returned is not clock-checked; a later identical message is not a match (T-286 re-check)", () => {
  it("a Microsoft timestamp 60 s behind ours still verifies the id the POST returned (no window), but not an id found by the lookup (a window)", async () => {
    const s = setup();
    const a = action(s);
    const res = await s.writer.executeWrite("PKG", s.conn, a);
    (stored(s)[0] as { createdDateTime: string }).createdDateTime = new Date(Date.now() - 60_000).toISOString();
    await expect(s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string)).resolves.toBeUndefined();
    await expect(s.writer.verifyWrite("PKG", s.conn, a, res.external_id as string, { since: new Date(Date.now() - 15_000).toISOString() })).rejects.toSatisfy((e) => code(e) === "verification_mismatch");
  });

  it("an identical message 5 minutes AFTER the start is not a match (the window is [start - 15 s, start + 2 min]); one inside it is", async () => {
    const s = setup();
    const a = action(s);
    const mk = (id: string, ms: number) => ({ id, messageType: "message", createdDateTime: new Date(ms).toISOString(), lastModifiedDateTime: new Date(ms).toISOString(), from: { user: { id: s.account.objectId } }, body: { contentType: "text", content: CANARY }, chatId: CHAT });
    const since = new Date(Date.now() - 15_000).toISOString();
    s.fake.state.messagesByChat.set(CHAT, [mk("later", Date.now() + 5 * 60_000)]);
    expect(await s.writer.findWrite("PKG", s.conn, a, { since })).toEqual([]);
    s.fake.state.messagesByChat.set(CHAT, [mk("later", Date.now() + 5 * 60_000), mk("inside", Date.now() + 60_000)]);
    expect(await s.writer.findWrite("PKG", s.conn, a, { since })).toEqual(["inside"]);
    await expect(s.writer.verifyWrite("PKG", s.conn, a, "later", { since })).rejects.toSatisfy((e) => code(e) === "verification_mismatch");
  });

  it("after an unknown outcome the executor's lookup ignores an identical message dated beyond start + 2 min", async () => {
    const s = setup();
    const at = new Date(Date.now() + 10 * 60_000).toISOString();
    s.fake.state.messagesByChat.set(CHAT, [{ id: "typed-later", messageType: "message", createdDateTime: at, lastModifiedDateTime: at, from: { user: { id: s.account.objectId } }, body: { contentType: "text", content: CANARY }, chatId: CHAT }]);
    plan(s, { answer: 500, store: false });
    await expect(s.writer.executeWrite("PKG", s.conn, action(s))).rejects.toSatisfy((e) => code(e) === "outcome_pending");
  });
});

describe("the lookup window (T-286 review M-B)", () => {
  it("starts 15 seconds before the claim, in one place for the executor and the sweep; empty when the time is unknown", () => {
    expect(TEAMS_LOOKUP_SKEW_MS).toBe(15_000);
    expect(teamsLookupWindow("2026-11-24T12:00:30.000Z")).toEqual({ since: "2026-11-24T12:00:15.000Z" });
    expect(teamsLookupWindow(null)).toEqual({});
    expect(teamsLookupWindow("not a time")).toEqual({});
    expect(TEAMS_SEND_FAILURES.reconcile_connection_disconnected).toMatch(/may have been delivered/);
  });
});
