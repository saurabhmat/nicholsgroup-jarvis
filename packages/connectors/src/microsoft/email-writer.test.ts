// The approvals-only Microsoft email write path (T-262 Save as draft, T-263 Send; spec §17 tests 20, 21, 23) over the REAL guard, token manager, Graph read client and
// write client, against the fake Graph mailbox (MSW, ../testing/msw/microsoft/mail-write.ts). Synthetic data only; no live call (rule 10). Every refusal is proved with
// the fake's own request log and the Vault twin's token-read counter, not only with the thrown error.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { computePayloadSha256 } from "../contract/writer";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, HARNESS_OWNER, TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMailWrite } from "../testing/msw/microsoft/mail-write";
import { createConnectorLogger, type LogEntry } from "../log/index";
import { DRAFT_CHANGED_MESSAGE, DRAFT_EXISTS_MESSAGE, createMicrosoftEmailWriter, MICROSOFT_WRITE_NOT_GRANTED_MESSAGE, NOT_IN_MAILBOX_MESSAGE, OUTCOME_UNKNOWN_MESSAGE, VERIFICATION_MISMATCH_MESSAGE, type MicrosoftEmailApprovedAction } from "./email-writer";
import { GRAPH_MAIL_WRITE_FEATURE, PORTAL_MARKER_PROPERTY_ID } from "./constants";
import { createGraphWriteClient } from "./write-client";

const MAIL_DOMAIN = "pubkgroup.example.test";
const MAILBOX = `exec@${MAIL_DOMAIN}`;
const CONV = "AAQkSyntheticConversation-C=";
const PARENT = "AAMkSyntheticParent-1=";
/** The first element, or a failed test (no non-null assertion). */
function at<T>(list: readonly T[], i = 0): T {
  const v = list[i];
  if (v === undefined) throw new Error(`no element ${String(i)}`);
  return v;
}
const BODY_CANARY = "synthetic-outgoing-body-canary-71e3-not-real";

const fake = createFakeMicrosoft();
const write = createFakeMailWrite(fake);
useMockServer(...fake.handlers, ...write.handlers);
afterEach(() => RateLimiter.resetForTests());

function setup(over: { features?: Record<string, boolean>; owner?: string | null; claimOpen?: boolean; domains?: string[]; providers?: ("google" | "microsoft")[]; sentPauses?: number[] } = {}) {
  write.reset();
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: over.providers ?? ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: over.domains ?? [MAIL_DOMAIN] } } });
  const made = h.connect("PKG", MAILBOX);
  made.row.features = over.features ?? { [GRAPH_MAIL_WRITE_FEATURE]: true };
  made.row.owner_user_id = over.owner === undefined ? HARNESS_OWNER : over.owner;
  write.seed(made.account, { id: PARENT, conversationId: CONV, subject: "Board deck", from: "dana@sender.example.test" });
  let t = Date.now();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  };
  const events: LogEntry[] = [];
  const logger = createConnectorLogger({ sink: (e) => events.push(e) });
  const claimChecks: { actionId: string; hash: string; approvedBy: string }[] = [];
  const writer = createMicrosoftEmailWriter({
    guard: h.guard,
    api: h.api,
    write: createGraphWriteClient({ guard: h.guard, tokens: h.tokens, httpOptions: { sleep, now: () => t } }),
    laneConfig: h.laneConfig,
    claims: { claimOpen: async (_l, actionId, hash, approvedBy) => (claimChecks.push({ actionId, hash, approvedBy }), over.claimOpen ?? true) },
    sleep,
    logger,
    now: () => Date.parse("2026-11-22T12:00:00Z"),
    ...(over.sentPauses ? { sentRetryPausesMs: over.sentPauses } : {}),
  });
  const action = (type: "email.send" | "email.save_draft" = "email.send", compose: Record<string, unknown> = {}, approvedBy = HARNESS_OWNER): MicrosoftEmailApprovedAction => {
    const payload = { fromMailbox: MAILBOX, to: ["dana@sender.example.test"], cc: ["cc@sender.example.test"], bcc: [], subject: "Re: Board deck", bodyText: `Thanks Dana.\n${BODY_CANARY}`, ...compose };
    const base = {
      id: randomUUID(),
      lane_id: "PKG",
      connection_id: made.conn.id,
      action_type: type,
      target: { mailbox: MAILBOX, ...(compose.inReplyTo ? { thread_id: (compose.inReplyTo as { threadId: string }).threadId } : {}) },
      payload,
      payload_schema_version: 1,
    };
    return { ...base, payload_sha256: computePayloadSha256(base as never), approved_by: approvedBy } as unknown as MicrosoftEmailApprovedAction;
  };
  const reply = { inReplyTo: { threadId: CONV, messageId: PARENT } };
  const nothingCalled = () => {
    expect(write.requests, "a refused write reached Graph").toHaveLength(0);
    expect(h.stats.tokenReads, "a refused write read a token").toBe(0);
  };
  return { h, made, writer, action, reply, claimChecks, sleeps, nothingCalled, events, account: made.account, conn: made.conn };
}


describe("Save as draft (spec §17 test 20)", () => {
  it("a reply: createReply in the approved conversation, then a PATCH of exactly the approved fields with the marker; read-back verifies", async () => {
    const { writer, action, reply, conn, account, h } = setup();
    const a = action("email.save_draft", reply);
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    const drafts = write.inFolder(account, "drafts");
    expect(drafts).toHaveLength(1);
    const d = at(drafts);
    expect(d.conversationId).toBe(CONV);
    expect(d.props.get(PORTAL_MARKER_PROPERTY_ID)).toBe(a.id);
    expect(d.subject).toBe("Re: Board deck");
    expect(d.to.map((x) => x.emailAddress.address)).toEqual(["dana@sender.example.test"]);
    expect(d.cc.map((x) => x.emailAddress.address)).toEqual(["cc@sender.example.test"]);
    expect(d.bodyContent).toContain(BODY_CANARY);
    expect(d.bodyContentType).toBe("text");
    expect(write.counts).toEqual({ created: 0, replies: 1, patched: 1, sent: 0 });
    // The wire: parent read first, createReply with an empty body, the PATCH carries no header (V-19) but the marker; every request carries the ImmutableId preference.
    const mutating = write.requests.filter((q) => q.method !== "GET");
    expect(mutating.map((q) => `${q.method} ${decodeURIComponent(q.path).replace(/\/v1\.0/, "")}`)).toEqual([`POST /me/messages/${PARENT}/createReply`, `PATCH /me/messages/${d.id}`]);
    const parentRead = write.requests.findIndex((q) => q.method === "GET" && decodeURIComponent(q.path).endsWith(`/me/messages/${PARENT}`));
    expect(parentRead).toBeGreaterThanOrEqual(0);
    expect(write.requests.findIndex((q) => q.path.endsWith("/createReply"))).toBeGreaterThan(parentRead); // the parent is read first
    expect(JSON.stringify(at(mutating, 1).body)).not.toContain("internetMessageHeaders");
    expect(write.requests.every((q) => /IdType="ImmutableId"/.test(q.prefer ?? ""))).toBe(true);
    expect(write.unexpected).toEqual([]);
    await writer.verifyWrite("PKG", conn, a, r.external_id as string);
    expect(h.logs.map((l) => JSON.stringify(l)).join("\n")).not.toContain(BODY_CANARY);
  });

  it("a new message: one POST carrying the recipients, subject, body, the header (create only) and the marker", async () => {
    const { writer, action, conn, account } = setup();
    const a = action("email.save_draft");
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    const d = at(write.inFolder(account, "drafts"));
    expect(d.headers).toEqual([{ name: "X-Portal-Action-Id", value: a.id }]);
    expect(d.props.get(PORTAL_MARKER_PROPERTY_ID)).toBe(a.id);
    expect(write.counts).toEqual({ created: 1, replies: 0, patched: 0, sent: 0 });
    await writer.verifyWrite("PKG", conn, a, r.external_id as string);
  });

  it("the marker lookup before any create is exactly the documented filter on Drafts (+ $select, $top), and a second run reuses the draft: no second one", async () => {
    const { writer, action, reply, conn, account } = setup();
    const a = action("email.save_draft", reply);
    await writer.executeWrite("PKG", conn, a);
    const first = at(write.requests.filter((q) => q.path.includes("/mailFolders/drafts/messages")));
    const q = new URL(`https://x${first.search}`).searchParams;
    expect([...q.keys()].sort()).toEqual(["$filter", "$select", "$top"]);
    expect(q.get("$filter")).toBe(`singleValueExtendedProperties/Any(ep: ep/id eq '${PORTAL_MARKER_PROPERTY_ID}' and ep/value eq '${a.id}')`);
    const again = await writer.executeWrite("PKG", conn, a);
    expect(again.outcome).toBe("already_applied");
    expect(write.inFolder(account, "drafts")).toHaveLength(1);
    expect(write.counts).toMatchObject({ replies: 1, patched: 1 });
  });

  it("a reply whose parent is in another conversation is refused before createReply", async () => {
    const { writer, action, conn } = setup();
    await expect(writer.executeWrite("PKG", conn, action("email.save_draft", { inReplyTo: { threadId: "another-conversation", messageId: PARENT } }))).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(write.requests.filter((q) => q.method !== "GET")).toEqual([]);
  });

  it("createReply that fails in a way that may have been processed ends outcome_unknown, with no PATCH and no second createReply", async () => {
    const { writer, action, reply, conn } = setup();
    write.failNext("createReply", 503);
    await expect(writer.executeWrite("PKG", conn, action("email.save_draft", reply))).rejects.toMatchObject({ info: { message: OUTCOME_UNKNOWN_MESSAGE } });
    expect(write.requests.filter((q) => q.method !== "GET")).toHaveLength(1);
  });

  it("a definite refusal (400) of the PATCH after createReply is reported as it is; nothing is repeated", async () => {
    const { writer, action, reply, conn } = setup();
    write.failNext("patch", 400);
    await expect(writer.executeWrite("PKG", conn, action("email.save_draft", reply))).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(write.counts).toMatchObject({ replies: 1, patched: 0 });
  });

  it("a PATCH that fails ambiguously is resolved by the marker (found: reused; not found: outcome_unknown)", async () => {
    const { writer, action, reply, conn } = setup();
    write.failNext("patch", 503); // nothing applied: no marker on the draft
    await expect(writer.executeWrite("PKG", conn, action("email.save_draft", reply))).rejects.toMatchObject({ info: { message: OUTCOME_UNKNOWN_MESSAGE } });
    expect(write.counts).toMatchObject({ replies: 1, patched: 0 });
  });

  it("a Graph that returns a draft not in the approved conversation is refused before the PATCH", async () => {
    const { writer, action, conn, account } = setup();
    write.seed(account, { id: "AAMkOther=", conversationId: CONV });
    // the fake's createReply copies the parent's conversation; ask for a thread the parent is not in via a parent in another conversation
    write.seed(account, { id: "AAMkParent2=", conversationId: "conv-2" });
    await expect(writer.executeWrite("PKG", conn, action("email.save_draft", { inReplyTo: { threadId: CONV, messageId: "AAMkParent2=" } }))).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(write.counts.replies).toBe(0);
  });
});

describe("Send (spec §17 test 21)", () => {
  it("creates the marked draft, sends it once, finds the sent copy by the marker and verifies it", async () => {
    const { writer, action, reply, conn, account } = setup();
    const a = action("email.send", reply);
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    expect(write.counts).toMatchObject({ replies: 1, patched: 1, sent: 1 });
    const sent = write.inFolder(account, "sentitems");
    expect(sent).toHaveLength(1);
    expect(write.inFolder(account, "drafts")).toHaveLength(0);
    expect(r.external_id).toBe(at(sent).id);
    await writer.verifyWrite("PKG", conn, a, r.external_id as string);
    expect(write.unexpected).toEqual([]);
  });

  it("the sent copy that is not in Sent Items at once is found with bounded retries", async () => {
    const { writer, action, conn, sleeps } = setup();
    write.sentLag = 2;
    const a = action("email.send");
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    expect(sleeps.filter((s) => s === 1000 || s === 2000).length).toBeGreaterThan(0);
    expect(write.counts.sent).toBe(1);
  });

  it("never assumes an id: the message id changes on send and the read-back still finds the copy by the marker", async () => {
    const { writer, action, conn, account } = setup();
    write.idChangesOnSend = true;
    const a = action("email.send");
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.external_id).toBe(at(write.inFolder(account, "sentitems")).id);
    await writer.verifyWrite("PKG", conn, a, "a-stale-draft-id");
    expect(write.counts.sent).toBe(1);
  });

  it("a fake that crashes AFTER accepting the send: the marker copy is found in Sent Items, already_applied, sent exactly once", async () => {
    const { writer, action, reply, conn, account } = setup();
    write.faultAfterSend = "crashAfterSend";
    const a = action("email.send", reply);
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("already_applied");
    expect(r.external_id).toBe(at(write.inFolder(account, "sentitems")).id);
    expect(write.counts.sent).toBe(1);
    // the send POST was made exactly once (never retried by the client)
    expect(write.requests.filter((q) => q.method === "POST" && q.path.endsWith("/send"))).toHaveLength(1);
  });

  it("a 503 after the send was applied is resolved the same way", async () => {
    const { writer, action, conn } = setup();
    write.faultAfterSend = "serverErrorAfterSend";
    const r = await writer.executeWrite("PKG", conn, action("email.send"));
    expect(r.outcome).toBe("already_applied");
    expect(write.counts.sent).toBe(1);
  });

  it("crash after accepting with no marker copy found twice: outcome_unknown; the recovery lookup (findWrite) finds the copy later and it verifies; nothing is sent again", async () => {
    const { writer, action, conn } = setup();
    write.faultAfterSend = "crashAfterSend";
    write.sentLag = 2; // the sent copy is hidden for the two lookups after the failure
    const a = action("email.send");
    await expect(writer.executeWrite("PKG", conn, a)).rejects.toMatchObject({ info: { message: OUTCOME_UNKNOWN_MESSAGE } });
    expect(write.counts.sent).toBe(1);
    const found = await writer.findWrite("PKG", conn, a);
    expect(found).toHaveLength(1);
    await writer.verifyWrite("PKG", conn, a, found[0] as string);
    expect(write.counts.sent).toBe(1);
  });

  it("a send that fails before Graph applied it (503) and finds no copy: outcome_unknown, nothing sent, never a second POST of the send", async () => {
    const { writer, action, conn } = setup();
    write.failNext("send", 503);
    await expect(writer.executeWrite("PKG", conn, action("email.send"))).rejects.toMatchObject({ info: { message: OUTCOME_UNKNOWN_MESSAGE } });
    expect(write.counts.sent).toBe(0);
    expect(write.requests.filter((q) => q.path.endsWith("/send"))).toHaveLength(1);
  });

  it("a definite refusal of the send (403) is reported as it is, with no marker lookup loop", async () => {
    const { writer, action, conn } = setup();
    write.failNext("send", 403);
    await expect(writer.executeWrite("PKG", conn, action("email.send"))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(write.counts.sent).toBe(0);
  });

  it("a second execution after a completed send finds the sent copy: nothing is created or sent again", async () => {
    const { writer, action, conn } = setup();
    const a = action("email.send");
    await writer.executeWrite("PKG", conn, a);
    const before = { ...write.counts };
    const again = await writer.executeWrite("PKG", conn, a);
    expect(again.outcome).toBe("already_applied");
    expect(write.counts).toEqual(before);
  });

  it("a marked draft found in Drafts BEFORE this run created one is never sent (a person is told to look): nothing is created, nothing is sent", async () => {
    const { writer, action, conn, account } = setup();
    const a = action("email.send");
    write.failNext("send", 403);
    await expect(writer.executeWrite("PKG", conn, a)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const before = { ...write.counts };
    await expect(writer.executeWrite("PKG", conn, a)).rejects.toMatchObject({ info: { message: DRAFT_EXISTS_MESSAGE } });
    expect(write.counts).toEqual(before);
    expect(write.inFolder(account, "drafts")).toHaveLength(1);
    expect(write.counts.sent).toBe(0);
  });

  it("an inbound or forged message carrying our marker (another sender, in Sent Items) never counts as our send", async () => {
    const { writer, action, conn, account } = setup();
    const a = action("email.send");
    const forged = write.seed(account, { id: "AAMkForged=", conversationId: "x", folder: "sentitems", from: "attacker@sender.example.test" });
    forged.props.set(PORTAL_MARKER_PROPERTY_ID, a.id);
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    expect(write.counts.sent).toBe(1);
  });
});

describe("refusals before any Graph request or token read (spec §17 test 23)", () => {
  it("a connection without graph_mail_write: the reconnect message, nothing called", async () => {
    const { writer, action, conn, nothingCalled } = setup({ features: {} });
    await expect(writer.executeWrite("PKG", conn, action())).rejects.toMatchObject({ info: { kind: "forbidden", message: MICROSOFT_WRITE_NOT_GRANTED_MESSAGE } });
    expect(MICROSOFT_WRITE_NOT_GRANTED_MESSAGE).toBe("Sending isn't enabled for this mailbox yet. Reconnect Microsoft with send permission in Settings");
    nothingCalled();
  });

  it("every other precondition", async () => {
    const t = setup();
    const a = action2(t);
    const cases: [string, () => Promise<unknown>][] = [
      ["payload changed after approval", () => t.writer.executeWrite("PKG", t.conn, { ...a, payload: { ...a.payload, subject: "Changed" } } as never)],
      ["sender is not the mailbox", () => t.writer.executeWrite("PKG", t.conn, t.action("email.send", { fromMailbox: "someone@pubkgroup.example.test" }))],
      ["target is another mailbox", () => t.writer.executeWrite("PKG", t.conn, { ...a, target: { mailbox: "other@pubkgroup.example.test" } } as never)],
      ["an approver who is not the owner (T-247)", () => t.writer.executeWrite("PKG", t.conn, t.action("email.send", {}, "00000000-0000-4000-8000-0000000000ff"))],
      ["another lane on the action", () => t.writer.executeWrite("PKG", t.conn, { ...a, lane_id: "APK" } as never)],
      ["another connection on the action", () => t.writer.executeWrite("PKG", t.conn, { ...a, connection_id: randomUUID() } as never)],
      ["an unsupported type", () => t.writer.executeWrite("PKG", t.conn, { ...a, action_type: "email.delete" } as never)],
      ["no approver", () => t.writer.executeWrite("PKG", t.conn, { ...a, approved_by: "" } as never)],
      ["a forged copy of the connection", () => t.writer.executeWrite("PKG", { ...t.conn } as never, a)],
    ];
    for (const [name, run] of cases) await expect(run(), name).rejects.toBeInstanceOf(ConnectorError);
    t.nothingCalled();
  });

  it("a row with no owner, a domain not allowed for the lane, an unclaimed action: refused, nothing called", async () => {
    const noOwner = setup({ owner: null });
    await expect(noOwner.writer.executeWrite("PKG", noOwner.conn, noOwner.action())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    noOwner.nothingCalled();
    const wrongDomain = setup({ domains: ["another.example.test"] });
    await expect(wrongDomain.writer.executeWrite("PKG", wrongDomain.conn, wrongDomain.action())).rejects.toBeInstanceOf(ConnectorError);
    wrongDomain.nothingCalled();
    const unclaimed = setup({ claimOpen: false });
    await expect(unclaimed.writer.executeWrite("PKG", unclaimed.conn, unclaimed.action())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    unclaimed.nothingCalled();
  });

  it("Microsoft no longer enabled for the lane: connection_unavailable, nothing called", async () => {
    const t = setup({ providers: ["google"] });
    await expect(t.writer.executeWrite("PKG", t.conn, t.action())).rejects.toMatchObject({ info: { kind: "connection_unavailable" } });
    t.nothingCalled();
  });

  it("a Google connection is refused", async () => {
    const t = setup();
    await expect(t.writer.executeWrite("PKG", { ...t.conn, provider: "google" } as never, t.action())).rejects.toBeInstanceOf(ConnectorError);
    t.nothingCalled();
  });

  it("the claim check runs with the action id, its hash and the approver", async () => {
    const { writer, action, conn, claimChecks } = setup();
    const a = action();
    await writer.executeWrite("PKG", conn, a);
    expect(claimChecks).toEqual([{ actionId: a.id, hash: a.payload_sha256, approvedBy: HARNESS_OWNER }]);
  });
});
const action2 = (t: ReturnType<typeof setup>) => t.action();

describe("read-back (verifyWrite) and recovery (findWrite)", () => {
  it("a sent copy with other recipients, a draft that became a sent item, or another subject is a mismatch", async () => {
    const { writer, action, conn, account } = setup();
    const a = action("email.send");
    await writer.executeWrite("PKG", conn, a);
    const copy = at(write.inFolder(account, "sentitems"));
    await writer.verifyWrite("PKG", conn, a, copy.id);
    copy.to = [{ emailAddress: { address: "someone-else@sender.example.test" } }];
    await expect(writer.verifyWrite("PKG", conn, a, copy.id)).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
    copy.to = [{ emailAddress: { address: "dana@sender.example.test" } }];
    copy.subject = "Different";
    await expect(writer.verifyWrite("PKG", conn, a, copy.id)).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
    copy.subject = "Re: Board deck";
    copy.bcc = [{ emailAddress: { address: "hidden@sender.example.test" } }];
    await expect(writer.verifyWrite("PKG", conn, a, copy.id)).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
  });

  it("a reply sent into another conversation is a mismatch", async () => {
    const { writer, action, reply, conn, account } = setup();
    const a = action("email.send", reply);
    await writer.executeWrite("PKG", conn, a);
    at(write.inFolder(account, "sentitems")).conversationId = "elsewhere";
    await expect(writer.verifyWrite("PKG", conn, a, "x")).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
  });

  it("no copy carrying the marker: not found (never a mismatch, never an assumed id)", async () => {
    const { writer, action, conn } = setup({ sentPauses: [] });
    await expect(writer.verifyWrite("PKG", conn, action("email.send"), "AAMkParent=")).rejects.toMatchObject({ info: { kind: "not_found", message: NOT_IN_MAILBOX_MESSAGE } });
  });

  it("findWrite finds the lost send or draft with zero writes and no claim check; an empty list when none", async () => {
    const t = setup();
    const send = t.action("email.send");
    expect(await t.writer.findWrite("PKG", t.conn, send)).toEqual([]);
    await t.writer.executeWrite("PKG", t.conn, send);
    const claims = t.claimChecks.length;
    const requests = write.requests.length;
    expect(await t.writer.findWrite("PKG", t.conn, send)).toHaveLength(1);
    expect(write.requests.slice(requests).every((q) => q.method === "GET")).toBe(true);
    expect(t.claimChecks.length).toBe(claims);
    const draft = t.action("email.save_draft");
    await t.writer.executeWrite("PKG", t.conn, draft);
    expect(await t.writer.findWrite("PKG", t.conn, draft)).toHaveLength(1);
  });

  it("findWrite runs the same checks as the write path (tampered payload, feature missing)", async () => {
    const t = setup();
    const a = t.action("email.send");
    await expect(t.writer.findWrite("PKG", t.conn, { ...a, payload: { ...a.payload, subject: "x" } } as never)).rejects.toBeInstanceOf(ConnectorError);
    const ng = setup({ features: {} });
    await expect(ng.writer.findWrite("PKG", ng.conn, ng.action())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    ng.nothingCalled();
  });
});

describe("logs and errors never carry the message, the recipients or a token", () => {
  it("after a failed send and a successful one", async () => {
    const { writer, action, conn, h } = setup();
    write.failNext("send", 403);
    const err = await writer.executeWrite("PKG", conn, action("email.send")).catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain(BODY_CANARY);
    const text = JSON.stringify([h.logs, h.apiErrors]);
    expect(text).not.toContain(BODY_CANARY);
    expect(text).not.toContain("dana@sender.example.test");
    expect(text).not.toContain(at([...fake.accounts.values()]).refreshToken);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Review round (T-262/T-263): planted drafts, the full check after recovery, a lagging sent copy, Bcc, the closed claim, the logger.
const plant = (t: ReturnType<typeof setup>, a: MicrosoftEmailApprovedAction, over: Record<string, unknown> = {}) => {
  const payload = a.payload as { to: string[]; cc: string[]; subject: string; bodyText: string };
  const m = write.seed(t.account, {
    id: `AAMkPlanted-${a.id}=`, conversationId: "conv-planted", folder: "drafts", isDraft: true, from: MAILBOX, subject: payload.subject,
    to: payload.to.map((address) => ({ emailAddress: { address } })), cc: payload.cc.map((address) => ({ emailAddress: { address } })),
    bodyContent: payload.bodyText, bodyContentType: "text", hasAttachments: false, replyTo: [], ...over,
  });
  m.props.set(PORTAL_MARKER_PROPERTY_ID, a.id);
  return m;
};
const PLANTS: [string, Record<string, unknown>][] = [
  ["an attachment", { hasAttachments: true }],
  ["a changed Reply-To", { replyTo: [{ emailAddress: { address: "elsewhere@sender.example.test" } }] }],
  ["an HTML body that renders to the same text", { bodyContentType: "html", bodyContent: `<p>Thanks Dana.</p><p>${BODY_CANARY}</p>` }],
  ["another body text", { bodyContent: "Different words" }],
  ["another recipient", { to: [{ emailAddress: { address: "someone-else@sender.example.test" } }] }],
];

describe("a draft this call did not create (security M1)", () => {
  it.each(PLANTS)("email.send never sends a planted marked draft with %s", async (_n, over) => {
    const t = setup();
    const a = t.action("email.send");
    plant(t, a, over);
    await expect(t.writer.executeWrite("PKG", t.conn, a)).rejects.toMatchObject({ info: { message: DRAFT_EXISTS_MESSAGE } });
    expect(write.counts).toEqual({ created: 0, replies: 0, patched: 0, sent: 0 });
  });

  it.each(PLANTS)("email.save_draft does not answer already_applied for a planted marked draft with %s", async (_n, over) => {
    const t = setup();
    const a = t.action("email.save_draft");
    plant(t, a, over);
    await expect(t.writer.executeWrite("PKG", t.conn, a)).rejects.toMatchObject({ info: { message: DRAFT_CHANGED_MESSAGE } });
    expect(write.counts.created + write.counts.replies + write.counts.sent).toBe(0);
  });

  it("email.save_draft: an identical planted marked draft IS already_applied", async () => {
    const t = setup();
    const a = t.action("email.save_draft");
    const m = plant(t, a);
    const r = await t.writer.executeWrite("PKG", t.conn, a);
    expect(r).toMatchObject({ outcome: "already_applied", external_id: m.id });
  });

  it("a draft recovered after an ambiguous create (applied, then 503) passes the FULL check and the send goes on; tampered meanwhile, it is refused and nothing is sent", async () => {
    const ok = setup();
    write.failAfterApply("create", 503);
    const a = ok.action("email.send");
    const r = await ok.writer.executeWrite("PKG", ok.conn, a);
    expect(r.outcome).toBe("accepted");
    expect(write.counts).toMatchObject({ created: 1, sent: 1 });
    for (const [name, over] of PLANTS.slice(0, 4)) {
      const t = setup();
      write.failAfterApply("create", 503);
      write.onApplied = (_k, m) => Object.assign(m, over);
      await expect(t.writer.executeWrite("PKG", t.conn, t.action("email.send")), name).rejects.toMatchObject({ info: { message: DRAFT_CHANGED_MESSAGE } });
      expect(write.counts.sent, name).toBe(0);
    }
  });

  it("a draft recovered after an ambiguous PATCH of a reply gets the same full check", async () => {
    const t = setup();
    write.failAfterApply("patch", 503);
    write.onApplied = (k, m) => {
      if (k === "patch") m.hasAttachments = true;
    };
    await expect(t.writer.executeWrite("PKG", t.conn, t.action("email.send", t.reply))).rejects.toMatchObject({ info: { message: DRAFT_CHANGED_MESSAGE } });
    expect(write.counts.sent).toBe(0);
  });
});

describe("an accepted send whose Sent Items copy is not visible yet (security M2)", () => {
  it("declares that the copy may lag; execute still answers accepted; the read-back says not_found until the copy shows (marker or id), then verifies; sent exactly once", async () => {
    const { writer, action, conn } = setup({ sentPauses: [] });
    expect(writer.sentCopyMayLag).toBe(true);
    write.sentLag = 3;
    write.hideIdWhileLagging = true;
    const a = action("email.send");
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    await expect(writer.verifyWrite("PKG", conn, a, r.external_id as string)).rejects.toMatchObject({ info: { kind: "not_found" } });
    write.sentLag = 0;
    await writer.verifyWrite("PKG", conn, a, r.external_id as string);
    expect(write.counts.sent).toBe(1);
  });

  it("the marker gone from the sent copy: found by the id returned at create (not a draft, in Sent Items, matching)", async () => {
    const { writer, action, conn } = setup({ sentPauses: [] });
    write.dropMarkerOnSend = true;
    const a = action("email.send", { bcc: ["hidden@sender.example.test"] });
    const r = await writer.executeWrite("PKG", conn, a);
    await writer.verifyWrite("PKG", conn, a, r.external_id as string);
    expect(write.unexpected).toEqual([]);
    expect(write.requests.filter((q) => q.method !== "GET").map((q) => q.method)).toEqual(["POST", "POST"]); // create + send only: the id check used read routes
  });

  it("by id, a copy that differs, or is still a draft, or is not in Sent Items, is never accepted", async () => {
    const { writer, action, conn, account } = setup({ sentPauses: [] });
    write.dropMarkerOnSend = true;
    const a = action("email.send");
    const r = await writer.executeWrite("PKG", conn, a);
    const copy = at(write.inFolder(account, "sentitems"));
    copy.to = [{ emailAddress: { address: "someone-else@sender.example.test" } }];
    await expect(writer.verifyWrite("PKG", conn, a, r.external_id as string)).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
    copy.to = [{ emailAddress: { address: "dana@sender.example.test" } }];
    copy.folder = "inbox";
    await expect(writer.verifyWrite("PKG", conn, a, r.external_id as string)).rejects.toMatchObject({ info: { kind: "not_found" } });
    copy.folder = "sentitems";
    copy.isDraft = true;
    await expect(writer.verifyWrite("PKG", conn, a, r.external_id as string)).rejects.toMatchObject({ info: { kind: "not_found" } });
    await expect(writer.verifyWrite("PKG", conn, a, "AAMkNoSuchMessage=")).rejects.toMatchObject({ info: { kind: "not_found" } });
  });

  it("neither the marker nor the id is visible yet: not_found (the reconciler keeps looking; its give-up as unknown is its own, tested in the approvals module)", async () => {
    const { writer, action, conn } = setup({ sentPauses: [] });
    write.dropMarkerOnSend = true;
    write.sentLag = 99;
    write.hideIdWhileLagging = true;
    const a = action("email.send");
    const r = await writer.executeWrite("PKG", conn, a);
    expect(r.outcome).toBe("accepted");
    await expect(writer.verifyWrite("PKG", conn, a, r.external_id as string)).rejects.toMatchObject({ info: { kind: "not_found" } });
    expect(write.counts.sent).toBe(1);
  });
});

describe("Bcc on the sent copy (code review)", () => {
  it("a sent copy that lists no Bcc does not turn a correct send into a mismatch; one that lists a DIFFERENT Bcc does; the draft's Bcc is compared strictly", async () => {
    const t = setup();
    const a = t.action("email.send", { bcc: ["hidden@sender.example.test"] });
    const r = await t.writer.executeWrite("PKG", t.conn, a);
    const copy = at(write.inFolder(t.account, "sentitems"));
    expect(copy.bcc.map((x) => x.emailAddress.address)).toEqual(["hidden@sender.example.test"]);
    copy.bcc = []; // Graph does not list Bcc on the sent copy
    await t.writer.verifyWrite("PKG", t.conn, a, r.external_id as string);
    copy.bcc = [{ emailAddress: { address: "another@sender.example.test" } }];
    await expect(t.writer.verifyWrite("PKG", t.conn, a, r.external_id as string)).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
    // the draft, before sending, carries the approved Bcc exactly (the create response is compared)
    const d = setup();
    const da = d.action("email.save_draft", { bcc: ["hidden@sender.example.test"] });
    const dr = await d.writer.executeWrite("PKG", d.conn, da);
    at(write.inFolder(d.account, "drafts")).bcc = [];
    await expect(d.writer.verifyWrite("PKG", d.conn, da, dr.external_id as string)).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
  });
});

describe("one execution (code review M2, L1)", () => {
  it.each(["email.send", "email.save_draft"] as const)("a closed claim means no Graph call at all (%s)", async (type) => {
    const t = setup({ claimOpen: false });
    await expect(t.writer.executeWrite("PKG", t.conn, t.action(type))).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(write.requests.filter((q) => q.method !== "GET")).toEqual([]);
    expect(write.requests).toHaveLength(0);
  });

  it("an unmarked reply draft that may be left behind, and each ambiguous recovery, are logged with ids only (never a body, subject or recipient)", async () => {
    const t = setup();
    write.failNext("createReply", 503);
    await expect(t.writer.executeWrite("PKG", t.conn, t.action("email.save_draft", t.reply))).rejects.toBeTruthy();
    write.failNext("patch", 400);
    await expect(t.writer.executeWrite("PKG", t.conn, t.action("email.save_draft", t.reply))).rejects.toBeTruthy();
    write.failAfterApply("create", 503);
    await t.writer.executeWrite("PKG", t.conn, t.action("email.save_draft"));
    const names = t.events.map((e) => `${e.event}:${String(e.fields.reason ?? e.fields.outcome ?? "")}`);
    expect(names).toContain("microsoft.write.unmarked_reply_draft:create_reply_ambiguous");
    expect(names).toContain("microsoft.write.unmarked_reply_draft:patch_refused");
    expect(names).toContain("microsoft.write.recovery:found");
    const text = JSON.stringify(t.events);
    expect(text).not.toContain(BODY_CANARY);
    expect(text).not.toContain("Board deck");
    expect(text).not.toContain("dana@sender.example.test");
    expect(t.events.find((e) => e.event === "microsoft.write.unmarked_reply_draft" && e.fields.reason === "patch_refused")?.connection_id).toBe(t.conn.id);
  });
});
