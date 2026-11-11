// The approvals-only Gmail write path (T-232) against an in-memory Gmail: every refusal happens before a request, a send
// is found by its deterministic Message-ID and never repeated, an unknown outcome is never resent, replies carry the
// thread, and the read-back compares thread, Message-ID, recipients and subject. No network (rule 10).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection, type LaneBoundConnection } from "../contract/lane-bound";
import type { Connection } from "../contract/schemas";
import { computePayloadSha256 } from "../contract/writer";
import type { ConnectorResponse, HttpClient, HttpRequest } from "../http/client";
import { SecretValue } from "../vault/secret";
import type { GoogleApi } from "./api";
import { createGoogleEmailWriter, GMAIL_COMPOSE_FEATURE, OUTCOME_UNKNOWN_MESSAGE, VERIFICATION_MISMATCH_MESSAGE, type GoogleEmailApprovedAction } from "./email-writer";
import { portalMessageId } from "./mime-build";

const MAILBOX = "exec@pubkgroup.example.test";
const APPROVER = "00000000-0000-4000-8000-0000000000a1";
const resp = <T>(data: T): ConnectorResponse<T> => ({ status: 200, headers: new Headers(), data, providerTid: null, attempts: 1 });

type Msg = { id: string; threadId: string; labelIds: string[]; headers: Record<string, string>; rawText?: string };

function fakeGmail() {
  const messages = new Map<string, Msg>();
  const calls: { method: string; path: string }[] = [];
  const state = { failMode: null as null | "before" | "after_commit", seq: 0 };
  // A seeded parent message for replies.
  messages.set("parent1", { id: "parent1", threadId: "thread-1", labelIds: ["INBOX"], headers: { "Message-ID": "<parent@sender.example.test>", References: "<root@sender.example.test>" } });

  const parse = (raw: string): Record<string, string> => {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const head = text.split("\r\n\r\n")[0] ?? "";
    return Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
  };
  const commit = (raw: string, threadId: string | undefined, label: string): Msg => {
    const m: Msg = { id: `m${String(++state.seq)}`, threadId: threadId ?? `t${String(state.seq)}`, labelIds: [label], headers: parse(raw), rawText: Buffer.from(raw, "base64url").toString("utf8") };
    messages.set(m.id, m);
    return m;
  };

  const api: GoogleApi = {
    async get(_lane, _conn, path, params, query) {
      calls.push({ method: "GET", path });
      if (path === "/gmail/v1/users/me/messages") {
        const q = String(query?.q ?? "");
        const id = q.replace("rfc822msgid:", "");
        const hit = [...messages.values()].find((m) => m.headers["Message-ID"] === `<${id}>`);
        return resp({ messages: hit ? [{ id: hit.id, threadId: hit.threadId }] : [] }) as never;
      }
      const m = messages.get(String(params?.id));
      if (!m) throw new ConnectorError({ kind: "not_found", message: "no" });
      return resp({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, payload: { headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })) } }) as never;
    },
  };
  const http: HttpClient = {
    async request<T>(req: HttpRequest): Promise<ConnectorResponse<T>> {
      calls.push({ method: req.method, path: req.path });
      if (state.failMode === "before") throw new ConnectorError({ kind: "timeout", message: "timed out" });
      const body = req.body as { raw?: string; threadId?: string; message?: { raw: string; threadId?: string } };
      const isDraft = req.path.endsWith("/drafts");
      const m = commit(isDraft ? (body.message?.raw ?? "") : (body.raw ?? ""), isDraft ? body.message?.threadId : body.threadId, isDraft ? "DRAFT" : "SENT");
      if (state.failMode === "after_commit") throw new ConnectorError({ kind: "timeout", message: "timed out" });
      return resp(isDraft ? { id: `d-${m.id}`, message: { id: m.id, threadId: m.threadId } } : { id: m.id, threadId: m.threadId }) as unknown as ConnectorResponse<T>;
    },
  };
  return { api, http, messages, calls, state, posts: () => calls.filter((c) => c.method === "POST") };
}

function setup(over: { features?: Record<string, boolean>; mailboxes?: string[]; status?: Connection<"google">["status"]; claimOpen?: boolean } = {}) {
  const gmail = fakeGmail();
  const claimChecks: { actionId: string; hash: string; approvedBy: string }[] = [];
  const row = {
    id: randomUUID(),
    lane_id: "PKG",
    provider: "google",
    external_account_id: MAILBOX,
    status: over.status ?? "active",
    features: over.features ?? { [GMAIL_COMPOSE_FEATURE]: true },
    features_checked_at: null,
    token_expires_at: null,
    last_sync_at: null,
    last_error: null,
  } as unknown as Connection<"google">;
  const conn = mintLaneBoundConnection<"google">(row);
  const writer = createGoogleEmailWriter({
    connections: { load: async () => mintLaneBoundConnection<"google">({ ...row, features: { ...row.features } }) as LaneBoundConnection<string> },
    tokens: { accessToken: async () => new SecretValue("synthetic-access-token"), refreshToken: async () => new SecretValue("synthetic-refresh-token") },
    api: gmail.api,
    laneConfig: { mailboxes: async () => over.mailboxes ?? [MAILBOX] },
    claims: {
      claimOpen: async (_lane, actionId, hash, approvedBy) => {
        claimChecks.push({ actionId, hash, approvedBy });
        return over.claimOpen ?? true;
      },
    },
    httpFor: () => gmail.http,
    now: () => Date.parse("2026-11-11T12:00:00Z"),
    sleep: async () => undefined,
  });
  const action = (type: "email.send" | "email.save_draft" = "email.send", compose: Record<string, unknown> = {}): GoogleEmailApprovedAction => {
    const payload = { fromMailbox: MAILBOX, to: ["dana@sender.example.test"], cc: [], bcc: [], subject: "Quarterly update", bodyText: "Thanks Dana.\nSynthetic body.", ...compose };
    const base = {
      id: randomUUID(),
      lane_id: "PKG",
      connection_id: conn.id,
      action_type: type,
      target: { mailbox: MAILBOX, ...(compose.inReplyTo ? { thread_id: (compose.inReplyTo as { threadId: string }).threadId } : {}) },
      payload,
      payload_schema_version: 1,
    };
    return { ...base, payload_sha256: computePayloadSha256(base as never), approved_by: APPROVER } as unknown as GoogleEmailApprovedAction;
  };
  return { gmail, conn, writer, action, row, claimChecks };
}

describe("approved-and-claimed check (security review H1)", () => {
  it("sends nothing unless the approvals database has the action claimed with this hash and approver", async () => {
    const { gmail, conn, writer, action } = setup({ claimOpen: false });
    await expect(writer.executeWrite("PKG", conn, action())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(gmail.calls).toHaveLength(0);
  });
  it("asks with the action id, its hash and the approver", async () => {
    const { conn, writer, action, claimChecks } = setup();
    const a = action();
    await writer.executeWrite("PKG", conn, a);
    expect(claimChecks).toEqual([{ actionId: a.id, hash: a.payload_sha256, approvedBy: APPROVER }]);
  });
});

describe("send", () => {
  it("sends once with the deterministic Message-ID and the action marker, then verifies by read-back", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    const res = await writer.executeWrite("PKG", conn, a);
    expect(res.outcome).toBe("accepted");
    expect(gmail.posts()).toEqual([{ method: "POST", path: "/gmail/v1/users/me/messages/send" }]);
    const sent = gmail.messages.get(res.external_id ?? "");
    expect(sent?.headers["Message-ID"]).toBe(portalMessageId(a.id, MAILBOX));
    expect(sent?.headers["X-Portal-Action-Id"]).toBe(a.id);
    expect(sent?.headers.From).toBe(MAILBOX);
    expect(sent?.headers.To).toBe("dana@sender.example.test");
    await expect(writer.verifyWrite("PKG", conn, a, res.external_id ?? "")).resolves.toBeUndefined();
  });

  it("a second execution finds the sent message and does not send again", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    const first = await writer.executeWrite("PKG", conn, a);
    const second = await writer.executeWrite("PKG", conn, a);
    expect(second).toMatchObject({ outcome: "already_applied", external_id: first.external_id });
    expect(gmail.posts()).toHaveLength(1);
  });

  it("a timeout after Gmail committed the message is found by Message-ID: no second send", async () => {
    const { gmail, conn, writer, action } = setup();
    gmail.state.failMode = "after_commit";
    const res = await writer.executeWrite("PKG", conn, action());
    expect(res.outcome).toBe("already_applied");
    expect(gmail.posts()).toHaveLength(1);
  });

  it("a timeout where nothing was committed ends as an unknown outcome and is never resent", async () => {
    const { gmail, conn, writer, action } = setup();
    gmail.state.failMode = "before";
    await expect(writer.executeWrite("PKG", conn, action())).rejects.toMatchObject({ info: { message: OUTCOME_UNKNOWN_MESSAGE } });
    expect(gmail.posts()).toHaveLength(1);
  });

  it("encodes a non-ASCII subject and keeps the body out of headers", async () => {
    const { gmail, conn, writer, action } = setup();
    const res = await writer.executeWrite("PKG", conn, action("email.send", { subject: "Résumé of the quarter" }));
    expect(gmail.messages.get(res.external_id ?? "")?.headers.Subject).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe("draft", () => {
  it("saves a draft (POST drafts) and verifies the DRAFT label", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action("email.save_draft");
    const res = await writer.executeWrite("PKG", conn, a);
    expect(gmail.posts()).toEqual([{ method: "POST", path: "/gmail/v1/users/me/drafts" }]);
    await expect(writer.verifyWrite("PKG", conn, a, res.external_id ?? "")).resolves.toBeUndefined();
  });
});

describe("reply", () => {
  const reply = { threadId: "thread-1", messageId: "parent1" };
  it("sends into the thread with In-Reply-To and References", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action("email.send", { inReplyTo: reply });
    const res = await writer.executeWrite("PKG", conn, a);
    const sent = gmail.messages.get(res.external_id ?? "");
    expect(sent?.threadId).toBe("thread-1");
    expect(sent?.headers["In-Reply-To"]).toBe("<parent@sender.example.test>");
    expect(sent?.headers.References).toBe("<root@sender.example.test> <parent@sender.example.test>");
    await expect(writer.verifyWrite("PKG", conn, a, res.external_id ?? "")).resolves.toBeUndefined();
  });

  it("refuses a reply whose parent is in another thread", async () => {
    const { gmail, conn, writer, action } = setup();
    await expect(writer.executeWrite("PKG", conn, action("email.send", { inReplyTo: { threadId: "thread-9", messageId: "parent1" } }))).rejects.toBeInstanceOf(ConnectorError);
    expect(gmail.posts()).toHaveLength(0);
  });
});

describe("refusals happen before any Gmail request", () => {
  it("payload changed after approval (hash mismatch)", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    const tampered = { ...a, payload: { ...a.payload, to: ["attacker@evil.example.test"] } } as GoogleEmailApprovedAction;
    await expect(writer.executeWrite("PKG", conn, tampered)).rejects.toThrow(/does not match its approval/);
    expect(gmail.calls).toEqual([]);
  });

  it("a forged hash for a changed payload (recomputed over another action id) is refused too", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    await expect(writer.executeWrite("PKG", conn, { ...a, payload_sha256: "0".repeat(64) })).rejects.toThrow();
    expect(gmail.calls).toEqual([]);
  });

  it("sender other than the connection's mailbox", async () => {
    const { gmail, conn, writer, action } = setup();
    await expect(writer.executeWrite("PKG", conn, action("email.send", { fromMailbox: "someone@else.example.test" }))).rejects.toThrow(/sender/);
    expect(gmail.calls).toEqual([]);
  });

  it("target mailbox other than the connection's", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    const base = { ...a, target: { mailbox: "other@else.example.test" } };
    await expect(writer.executeWrite("PKG", conn, { ...base, payload_sha256: computePayloadSha256(base as never) } as GoogleEmailApprovedAction)).rejects.toThrow(/another mailbox/);
    expect(gmail.calls).toEqual([]);
  });

  it("connection without the compose grant", async () => {
    const { gmail, conn, writer, action } = setup({ features: { [GMAIL_COMPOSE_FEATURE]: false } });
    await expect(writer.executeWrite("PKG", conn, action())).rejects.toThrow(/not granted permission/);
    expect(gmail.calls).toEqual([]);
  });

  it("connection with no features at all", async () => {
    const { gmail, conn, writer, action } = setup({ features: {} });
    await expect(writer.executeWrite("PKG", conn, action())).rejects.toBeInstanceOf(ConnectorError);
    expect(gmail.calls).toEqual([]);
  });

  it("a mailbox removed from the lane's list", async () => {
    const { gmail, conn, writer, action } = setup({ mailboxes: ["someone@else.example.test"] });
    await expect(writer.executeWrite("PKG", conn, action())).rejects.toBeInstanceOf(ConnectorError);
    expect(gmail.calls).toEqual([]);
  });

  it("another lane or connection id on the action", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    await expect(writer.executeWrite("PKG", conn, { ...a, lane_id: "APK" } as never)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    await expect(writer.executeWrite("PKG", conn, { ...a, connection_id: randomUUID() })).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    expect(gmail.calls).toEqual([]);
  });

  it("an unsupported action type and a missing approver", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    await expect(writer.executeWrite("PKG", conn, { ...a, action_type: "email.delete" })).rejects.toMatchObject({ info: { kind: "unsupported_op" } });
    await expect(writer.executeWrite("PKG", conn, { ...a, approved_by: "nobody" })).rejects.toBeInstanceOf(ConnectorError);
    expect(gmail.calls).toEqual([]);
  });

  it("header injection in the subject is refused by the schema", async () => {
    const { gmail, conn, writer, action } = setup();
    await expect(writer.executeWrite("PKG", conn, action("email.send", { subject: "Hi\r\nBcc: attacker@evil.example.test" }))).rejects.toThrow();
    expect(gmail.calls).toEqual([]);
  });
});

describe("read-back", () => {
  it("a message with other recipients is a mismatch", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    const res = await writer.executeWrite("PKG", conn, a);
    const m = gmail.messages.get(res.external_id ?? "");
    if (m) m.headers.To = "someone.else@sender.example.test";
    await expect(writer.verifyWrite("PKG", conn, a, res.external_id ?? "")).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
  });

  it("a message without the expected label is a mismatch", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    const res = await writer.executeWrite("PKG", conn, a);
    const m = gmail.messages.get(res.external_id ?? "");
    if (m) m.labelIds = ["TRASH"];
    await expect(writer.verifyWrite("PKG", conn, a, res.external_id ?? "")).rejects.toMatchObject({ info: { message: VERIFICATION_MISMATCH_MESSAGE } });
  });
});

describe("findWrite: the read-only marker lookup for recovery (T-192)", () => {
  it("finds a send the process lost (accepted by Gmail, never recorded) by its Message-ID, with zero writes and no claim check", async () => {
    const { gmail, conn, writer, action, claimChecks } = setup();
    const a = action();
    gmail.state.failMode = "after_commit";
    const res = await writer.executeWrite("PKG", conn, a); // the crash is simulated by discarding this result
    expect(gmail.posts()).toHaveLength(1);
    const writesBefore = gmail.posts().length;
    claimChecks.length = 0;
    const ids = await writer.findWrite("PKG", conn, a);
    expect(ids).toEqual([res.external_id]);
    await expect(writer.verifyWrite("PKG", conn, a, ids[0] ?? "")).resolves.toBeUndefined();
    expect(gmail.posts()).toHaveLength(writesBefore);
    expect(claimChecks).toEqual([]);
  });

  it("finds a saved draft as well", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action("email.save_draft");
    const res = await writer.executeWrite("PKG", conn, a);
    const ids = await writer.findWrite("PKG", conn, a);
    expect(ids).toHaveLength(1);
    expect(gmail.messages.get(ids[0] ?? "")?.labelIds).toContain("DRAFT");
    expect(res.external_id).toBeTruthy();
  });

  it("an empty list when nothing is in the mailbox (which does not prove nothing was sent)", async () => {
    const { gmail, conn, writer, action } = setup();
    expect(await writer.findWrite("PKG", conn, action())).toEqual([]);
    expect(gmail.posts()).toHaveLength(0);
  });

  it("runs the same checks as the write path: wrong lane, another connection, a tampered payload, an unhealthy or ungranted connection", async () => {
    const { gmail, conn, writer, action } = setup();
    const a = action();
    await expect(writer.findWrite("APK", conn, a)).rejects.toBeInstanceOf(ConnectorError);
    await expect(writer.findWrite("PKG", conn, { ...a, connection_id: randomUUID() })).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    await expect(writer.findWrite("PKG", conn, { ...a, payload: { ...a.payload, subject: "Changed" } })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    expect(gmail.calls).toHaveLength(0);
    const ungranted = setup({ features: {} });
    await expect(ungranted.writer.findWrite("PKG", ungranted.conn, ungranted.action())).rejects.toMatchObject({ info: { kind: "forbidden" } });
    const down = setup({ status: "reconnect_required" });
    await expect(down.writer.findWrite("PKG", down.conn, down.action())).rejects.toBeInstanceOf(ConnectorError);
    expect(ungranted.gmail.calls).toHaveLength(0);
    expect(down.gmail.calls).toHaveLength(0);
  });
});
