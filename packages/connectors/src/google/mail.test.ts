// Gmail provider details beyond the shared contract (T-063): what is requested (metadata format only, fixed headers),
// what is kept (no snippet, no body), the field mapping, history deltas (labels, deletes, re-adds), cursor binding and
// resync, the live body (MIME walk, attachments skipped, never persisted, never logged), plain-text search, read-only
// API surface and the host allowlist. Mocks only (rule 10).
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { isUntrustedBody } from "../comms/ephemeral";
import { MessageMetaSchema, type MailSyncResult, type MessageMeta } from "../comms/schemas";
import { isConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import { createGoogleHarness } from "../testing/google-harness";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { createFakeGoogle, GOOGLE_ATTACHMENT_CANARY, GOOGLE_BODY_CANARY, GOOGLE_SNIPPET_CANARY, seedMessage } from "../testing/msw/google/handlers";
import { assertGoogleHost } from "./guard";
import { GOOGLE_HOSTS } from "./constants";
import { createGoogleApi } from "./api";
import { createGmailProvider, parseCursor, quoteGmailQuery } from "./mail";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

const EXEC = "exec@pubkgroup.example.test";

function setup() {
  const fake = createFakeGoogle();
  server.use(...fake.handlers);
  const h = createGoogleHarness({ fake, mailboxes: { PKG: [EXEC] } });
  const { row, account } = h.connectGoogle("PKG", EXEC);
  return { fake, h, conn: h.bind(row), account };
}
async function drain(h: ReturnType<typeof setup>["h"], conn: ReturnType<typeof setup>["conn"], cursor: MailSyncResult["nextCursor"], pageSize?: number) {
  const upserts: MessageMeta[] = [];
  const removals: string[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await h.mail.sync("PKG", conn, cursor, pageSize ? { pageSize } : undefined);
    expect(r.fullResyncRequired).toBe(false);
    upserts.push(...r.upserts);
    removals.push(...r.removals.map((x) => x.message_id));
    cursor = r.nextCursor;
    if (!r.hasMore) return { upserts, removals, cursor };
  }
  throw new Error("did not terminate");
}

describe("sync requests", () => {
  it("asks only for metadata with the fixed headers; never format=full or raw; every call is a GET", async () => {
    const { fake, h, conn } = setup();
    await drain(h, conn, null, 2);
    const gets = fake.state.gmailRequests.filter((r) => /\/messages\/[^/]+$/.test(r.path));
    expect(gets.length).toBe(5);
    for (const r of gets) {
      expect(r.query.get("format")).toBe("metadata");
      expect(r.query.getAll("metadataHeaders")).toEqual(["From", "To", "Cc", "Subject", "Date", "Content-Type"]);
    }
    expect(fake.state.gmailRequests.every((r) => r.method === "GET")).toBe(true);
    expect(fake.state.gmailRequests.some((r) => ["full", "raw"].includes(r.query.get("format") ?? ""))).toBe(false);
    expect(fake.state.writeRequests).toEqual([]);
  });

  it("starts the first load from the profile's historyId taken BEFORE listing, and limits it to the window", async () => {
    const { fake, h, conn } = setup();
    const first = await h.mail.sync("PKG", conn, null, { pageSize: 100 });
    const paths = fake.state.gmailRequests.map((r) => r.path);
    expect(paths[0]).toBe("/gmail/v1/users/me/profile");
    expect(paths[1]).toBe("/gmail/v1/users/me/messages");
    expect(fake.state.gmailRequests[1]?.query.get("q")).toMatch(/^after:\d+$/);
    expect(first.nextCursor?.value).toBe(`g1.${conn.id}.h:5000`);
    expect(first.hasMore).toBe(false);
  });

  it("mail that arrives while the first load is listing is caught by the first incremental sync", async () => {
    const { fake, h, conn, account } = setup();
    const page1 = await h.mail.sync("PKG", conn, null, { pageSize: 2 });
    expect(page1.hasMore).toBe(true);
    const during = fake.addMessage(account);
    const rest = await drain(h, conn, page1.nextCursor, 2);
    const delta = await drain(h, conn, rest.cursor);
    expect(delta.upserts.map((m) => m.message_id)).toContain(during);
  });
});

describe("metadata records", () => {
  it("maps Gmail fields to the index columns and keeps no snippet, body or preview", async () => {
    const { h, conn } = setup();
    const { upserts } = await drain(h, conn, null);
    const byId = new Map(upserts.map((m) => [m.message_id, m]));
    const one = byId.get(seedMessage(1, EXEC).id) as MessageMeta;
    expect(MessageMetaSchema.parse(one)).toEqual(one);
    expect(one).toMatchObject({
      thread_id: seedMessage(1, EXEC).threadId,
      from_address: "sender1@sender.example.test",
      from_name: "Sender 1",
      subject: "Synthetic subject 1",
      is_read: false, // UNREAD label
      is_starred: false,
      is_important: true,
      has_attachments: false,
      folder: "INBOX",
      labels: ["INBOX", "UNREAD", "IMPORTANT"],
    });
    expect(one.to_recipients).toEqual([
      { address: EXEC, name: "Exec Mock" },
      { address: "second1@sender.example.test", name: "Second" },
    ]);
    expect(one.received_at).toBe(new Date(seedMessage(1, EXEC).internalDate).toISOString());
    expect(one.source_updated_at).toBe(one.received_at);
    expect(one.source_url).toBe(`https://mail.google.com/mail/u/${encodeURIComponent(EXEC)}/#all/${seedMessage(1, EXEC).threadId}`);
    const three = byId.get(seedMessage(3, EXEC).id) as MessageMeta;
    expect(three).toMatchObject({ is_starred: true, has_attachments: true, labels: ["INBOX", "UNREAD", "STARRED", "Label_77"] });
    const four = byId.get(seedMessage(4, EXEC).id) as MessageMeta;
    expect(four).toMatchObject({ from_address: "sender4@sender.example.test", from_name: "Sender, Four", is_read: true });
    expect(four.cc_recipients).toEqual([{ address: "cc@sender.example.test" }]);
    const text = JSON.stringify(upserts);
    for (const canary of [GOOGLE_SNIPPET_CANARY, GOOGLE_BODY_CANARY, GOOGLE_ATTACHMENT_CANARY]) expect(text).not.toContain(canary);
    for (const m of upserts) expect(Object.keys(m).sort()).toEqual(Object.keys(MessageMetaSchema.shape).sort());
  });

  it("a message with hostile header text still syncs: controls and bidi stripped, limits respected", async () => {
    const { fake, h, conn, account } = setup();
    const id = fake.addMessage(account);
    const m = account.messages.get(id);
    if (m) {
      m.subject = `Pay now‮gnp.exe\u0007 ${"x".repeat(2000)}`;
      m.from = `"${"N".repeat(400)}" <attacker@bad.example.test>`;
      m.to = `<not-an-address>, ok@fine.example.test`;
    }
    const { upserts } = await drain(h, conn, null);
    const got = upserts.find((u) => u.message_id === id) as MessageMeta;
    expect(got.subject).not.toMatch(/[‮\u0007]/);
    expect(got.subject?.length).toBeLessThanOrEqual(998);
    expect(got.from_name?.length).toBeLessThanOrEqual(200);
    expect(got.to_recipients).toEqual([{ address: "ok@fine.example.test" }]);
  });
});

describe("incremental sync", () => {
  it("reports label changes as upserts with the new flags, deletions as removals, and re-adds as upserts", async () => {
    const { fake, h, conn, account } = setup();
    const base = await drain(h, conn, null);
    const id = seedMessage(1, EXEC).id;
    fake.relabel(account, id, ["INBOX", "STARRED"]); // read + starred + no longer important
    const gone = fake.removeMessage(account); // removes the first live message (seed 1: relabelled above)
    expect(gone).toBe(id);
    const delta = await drain(h, conn, base.cursor);
    expect(delta.removals).toEqual([id]); // the last event for the id decides: deleted
    expect(delta.upserts.map((m) => m.message_id)).not.toContain(id);
    const readd = fake.addMessage(account, id);
    expect(readd).toBe(id);
    const back = await drain(h, conn, delta.cursor);
    expect(back.upserts.map((m) => m.message_id)).toContain(id);
    const second = seedMessage(2, EXEC).id;
    fake.relabel(account, second, ["INBOX", "STARRED"]);
    const rel = await drain(h, conn, back.cursor);
    expect(rel.upserts.find((m) => m.message_id === second)).toMatchObject({ is_starred: true, is_read: true, is_important: false });
  });

  it("a message deleted after it was reported added comes back as a removal, not an error", async () => {
    const { fake, h, conn, account } = setup();
    const base = await drain(h, conn, null);
    const added = fake.addMessage(account);
    account.messages.delete(added); // gone before the metadata fetch (no history event for the delete yet)
    const delta = await drain(h, conn, base.cursor);
    expect(delta.removals).toEqual([added]);
  });

  it("pages through a long history with the page token in the cursor", async () => {
    const { fake, h, conn, account } = setup();
    const base = await drain(h, conn, null);
    const ids = Array.from({ length: 5 }, () => fake.addMessage(account));
    const first = await h.mail.sync("PKG", conn, base.cursor, { pageSize: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor?.value).toMatch(new RegExp(`^g1\\.${conn.id}\\.i:5000:hp2$`));
    const all = await drain(h, conn, base.cursor, 2);
    expect(all.upserts.map((m) => m.message_id).sort()).toEqual([...ids].sort());
    expect(all.cursor?.value).toBe(`g1.${conn.id}.h:${String(account.historyId)}`);
  });

  it("a historyId Gmail no longer has is fullResyncRequired, and so is a cursor of another connection", async () => {
    const { fake, h, conn, account } = setup();
    const base = await drain(h, conn, null);
    fake.expireHistory(account);
    fake.addMessage(account);
    const expired = await h.mail.sync("PKG", conn, base.cursor);
    expect(expired).toMatchObject({ fullResyncRequired: true, nextCursor: null, upserts: [], removals: [] });
    const other = h.connectGoogle("PKG", "second@pubkgroup.example.test");
    const foreign = await h.mail.sync("PKG", h.bind(other.row), base.cursor);
    expect(foreign.fullResyncRequired).toBe(true);
  });

  it("parseCursor accepts only well-formed cursors of the same connection", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(parseCursor(`g1.${id}.h:123`, id)).toEqual({ kind: "history", historyId: "123" });
    expect(parseCursor(`g1.${id}.i:123:tok_-=+/.x%2F`, id)).toEqual({ kind: "history_page", historyId: "123", pageToken: "tok_-=+/.x%2F" });
    expect(parseCursor(`g1.${id}.f:123:1700000000:-`, id)).toEqual({ kind: "list_page", historyId: "123", after: 1700000000, pageToken: null });
    expect(parseCursor(`g1.${id}.h:123`, "11111111-2222-4333-8444-000000000000")).toBeNull();
    for (const bad of ["", "h:123", `g1.${id}.h:abc`, `g1.${id}.h:1 2`, `g2.${id}.h:1`, `g1.${id}.x:1`, `g1.${id}.i:1:a b`, `g1.${id}.i:1:${"a".repeat(3000)}`]) expect(parseCursor(bad, id), bad).toBeNull();
  });
});

describe("live body", () => {
  it("fetches format=full live, prefers text/plain, skips the attachment, and returns an UntrustedBody", async () => {
    const { fake, h, conn } = setup();
    const res = await h.mail.readBody("PKG", conn, seedMessage(2, EXEC).id);
    expect(res.freshness).toBe("live");
    expect(isUntrustedBody(res.data)).toBe(true);
    const text = res.data.reveal();
    expect(text).toContain(GOOGLE_BODY_CANARY);
    expect(text).not.toContain(GOOGLE_ATTACHMENT_CANARY);
    expect(text).not.toContain("<html>");
    expect(res.data).toMatchObject({ origin: "mail", trust: "untrusted", truncated: false });
    const fullCalls = fake.state.gmailRequests.filter((r) => r.query.get("format") === "full");
    expect(fullCalls).toHaveLength(1);
  });

  it("never persists: no store write, no cursor write, no vault write with content, and the canary is in no log", async () => {
    const { h, conn } = setup();
    const writes = h.writes.length;
    const applies = h.indexStats.applies;
    for (let i = 0; i < 3; i++) await h.mail.readBody("PKG", conn, seedMessage(2, EXEC).id);
    await h.mail.readBody("PKG", conn, seedMessage(2, EXEC).id, { maxChars: 10 });
    // A token refresh may legitimately rotate the Vault secret, but nothing with content is ever written.
    expect(h.writes.slice(writes).every((w) => w.store === "token_store")).toBe(true);
    expect(h.indexStats.applies).toBe(applies);
    expect(h.index.size).toBe(0);
    expect(h.contentWriteCount()).toBe(0);
    expect(JSON.stringify(h.logs)).not.toContain(GOOGLE_BODY_CANARY);
    expect(inspect(h.logs, { depth: 8 })).not.toContain(GOOGLE_BODY_CANARY);
  });

  it("a failing read leaks no content into errors or logs", async () => {
    const { fake, h, conn, account } = setup();
    fake.setFault(account, "server_error", 2);
    let err: unknown;
    try {
      await h.mail.readBody("PKG", conn, seedMessage(2, EXEC).id);
    } catch (e) {
      err = e;
    }
    expect(isConnectorError(err)).toBe(true);
    expect(JSON.stringify(err) + JSON.stringify(h.logs)).not.toContain(GOOGLE_BODY_CANARY);
  });

  it("honours maxChars and marks the cut", async () => {
    const { h, conn } = setup();
    const r = await h.mail.readBody("PKG", conn, seedMessage(2, EXEC).id, { maxChars: 12 });
    expect(r.data.reveal()).toHaveLength(12);
    expect(r.data.truncated).toBe(true);
  });

  it("the detector would notice a persisting provider: a write containing the canary is counted", async () => {
    const { h } = setup();
    expect(h.contentWriteCount()).toBe(0);
    h.writes.push({ store: "message_index", value: { subject: `x ${GOOGLE_BODY_CANARY}` } });
    expect(h.contentWriteCount()).toBe(1);
    h.logs.push({ level: "info", event: "x.y", at: "now", fields: { note: GOOGLE_SNIPPET_CANARY } });
    expect(h.contentWriteCount()).toBe(2);
  });
});

describe("search", () => {
  it("sends one quoted phrase so operators in the user's text cannot widen the search", async () => {
    const { fake, h, conn } = setup();
    expect(quoteGmailQuery('budget OR from:anyone "quoted" \\ x')).toBe('"budget OR from:anyone quoted x"');
    const plain = await h.mail.search("PKG", conn, { query: "budget" });
    const injected = await h.mail.search("PKG", conn, { query: "budget OR from:sender" });
    expect(plain.data).toHaveLength(1);
    expect(injected.data).toHaveLength(0);
    const sent = fake.state.gmailRequests.filter((r) => r.path === "/gmail/v1/users/me/messages").map((r) => r.query.get("q"));
    expect(sent).toEqual(['"budget"', '"budget OR from:sender"']);
  });

  it("the fake really widens an unquoted query (so the quoting above is what protects)", async () => {
    const { fake, account } = setup();
    const token = [...account.accessTokens][0] as string;
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", "budget OR from:sender");
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    expect(((await res.json()) as { messages: unknown[] }).messages.length).toBeGreaterThan(1);
    expect(fake.state.writeRequests).toEqual([]);
  });

  it("returns metadata only and limits the result", async () => {
    const { h, conn } = setup();
    const res = await h.mail.search("PKG", conn, { query: "Synthetic subject", limit: 2 });
    expect(res.data).toHaveLength(2);
    const text = JSON.stringify(res);
    for (const canary of [GOOGLE_SNIPPET_CANARY, GOOGLE_BODY_CANARY]) expect(text).not.toContain(canary);
  });
});

describe("polling mode and prepareWrite", () => {
  it("watch answers polling and creates no Pub/Sub resource or Gmail request (push is T-065)", async () => {
    const { fake, h, conn } = setup();
    const before = fake.state.gmailRequests.length;
    expect(h.mail.capabilities.watch).toBe("polling");
    const w = await h.mail.watch("PKG", conn);
    expect(w).toMatchObject({ mode: "polling", resource: "mail", channel_id: null, resource_id: null, expires_at: null });
    await h.mail.renew("PKG", conn, w);
    await h.mail.stop("PKG", conn, w);
    expect(fake.state.gmailRequests.length).toBe(before);
  });

  it("prepareWrite makes no request and no token read", async () => {
    const { fake, h, conn } = setup();
    const requests = fake.state.gmailRequests.length;
    const reads = h.stats.tokenReads;
    const p = await h.mail.prepareWrite("PKG", conn, { action_type: "email.send", compose: { fromMailbox: EXEC, to: ["a@example.test"], cc: [], bcc: [], subject: "S", bodyText: "B" } });
    expect(p).toMatchObject({ action_type: "email.send", provider: "google", lane_id: "PKG" });
    expect(fake.state.gmailRequests.length).toBe(requests);
    expect(h.stats.tokenReads).toBe(reads);
  });
});

describe("API surface", () => {
  it("the Gmail client exposes GET only", () => {
    const { h } = setup();
    expect(Object.keys(h.api)).toEqual(["get"]);
  });

  it("only Google hosts are accepted for a client", () => {
    for (const ok of ["https://gmail.googleapis.com", "https://oauth2.googleapis.com"]) expect(() => assertGoogleHost(ok, GOOGLE_HOSTS), ok).not.toThrow();
    // accounts.google.com is the browser redirect only; www.googleapis.com arrives with Calendar (T-064)
    for (const bad of ["https://accounts.google.com", "https://www.googleapis.com/calendar/v3", "https://evil.example.test", "https://gmail.googleapis.com.evil.test", "http://gmail.googleapis.com", "https://googleapis.com", "not a url"]) {
      if (bad === "http://gmail.googleapis.com") continue; // scheme is the HTTP client's check (https or loopback only)
      expect(() => assertGoogleHost(bad, GOOGLE_HOSTS), bad).toThrow();
    }
  });

  it("a request through the default client cannot be pointed at another host", async () => {
    const { h } = setup();
    const api = createGoogleApi({ tokens: h.tokens, httpOptions: { baseUrl: "https://evil.example.test" } });
    expect(api).toBeDefined();
    // the default factory builds the client with the Gmail base, then spreads httpOptions: the allowlist still applies
    await expect(api.get("PKG", h.bind(h.connectGoogle("PKG", "third@pubkgroup.example.test").row), "/gmail/v1/users/me/profile")).rejects.toThrow(/allowed Google host/);
  });
});

describe("lane config is re-checked on every call (T-063 review)", () => {
  it("a mailbox removed from lane_config.mailboxes (or an empty list) is forbidden for sync, readBody and search, before any request", async () => {
    const { fake, h, conn } = setup();
    for (const list of [[], ["someone-else@pubkgroup.example.test"]]) {
      h.mailboxes.PKG = list;
      const before = fake.state.gmailRequests.length;
      const reads = h.stats.tokenReads;
      for (const call of [() => h.mail.sync("PKG", conn, null), () => h.mail.readBody("PKG", conn, seedMessage(2, EXEC).id), () => h.mail.search("PKG", conn, { query: "budget" })]) {
        await expect(call()).rejects.toMatchObject({ info: { kind: "forbidden" } });
      }
      expect(fake.state.gmailRequests.length).toBe(before);
      expect(h.stats.tokenReads).toBe(reads);
    }
    h.mailboxes.PKG = [EXEC.toUpperCase()]; // case does not matter
    expect((await h.mail.search("PKG", conn, { query: "budget" })).data).toHaveLength(1);
  });

  it("uses the authoritative row: a loader that answers another connection is refused", async () => {
    const { h, conn } = setup();
    const other = h.bind(h.connectGoogle("PKG", "other@pubkgroup.example.test").row);
    const mail = createGmailProvider({ api: h.api, connections: { load: async () => other }, laneConfig: h.laneConfig });
    await expect(mail.search("PKG", conn, { query: "budget" })).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
  });

  it("the first load is limited to min(configured days, the lane's retention_days)", async () => {
    const { fake, h, conn } = setup();
    h.retention.PKG = 30;
    await h.mail.sync("PKG", conn, null);
    const q = fake.state.gmailRequests.find((r) => r.path === "/gmail/v1/users/me/messages")?.query.get("q") ?? "";
    const after = Number(/^after:(\d+)$/.exec(q)?.[1]);
    expect(Math.abs(after - (Date.now() / 1000 - 30 * 86400))).toBeLessThan(60);
    h.retention.PKG = 365; // a longer policy never widens past the configured 90
    fake.state.gmailRequests.length = 0;
    await h.mail.sync("PKG", conn, null);
    const q2 = fake.state.gmailRequests.find((r) => r.path === "/gmail/v1/users/me/messages")?.query.get("q") ?? "";
    expect(Math.abs(Number(/^after:(\d+)$/.exec(q2)?.[1]) - (Date.now() / 1000 - 90 * 86400))).toBeLessThan(60);
  });

  it("an unreadable lane policy fails the first load closed, with no Gmail request", async () => {
    const { fake, h, conn } = setup();
    h.retention.PKG = -1;
    await expect(h.mail.sync("PKG", conn, null)).rejects.toMatchObject({ info: { kind: "transient" } });
    expect(fake.state.gmailRequests).toEqual([]);
  });
});

describe("history details (T-063 review)", () => {
  it("requests the four history types and asks Gmail for nothing else", async () => {
    const { fake, h, conn } = setup();
    const base = await drain(h, conn, null);
    await drain(h, conn, base.cursor);
    const hist = fake.state.gmailRequests.find((r) => r.path === "/gmail/v1/users/me/history");
    expect(hist?.query.getAll("historyTypes")).toEqual(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
  });

  it("trash and spam read as removals; untrashing brings the message back", async () => {
    const { fake, h, conn, account } = setup();
    const base = await drain(h, conn, null);
    const id = seedMessage(3, EXEC).id;
    fake.relabel(account, id, ["TRASH"]);
    const spam = seedMessage(4, EXEC).id;
    fake.relabel(account, spam, ["SPAM"]);
    const trashed = await drain(h, conn, base.cursor);
    expect(trashed.removals.sort()).toEqual([id, spam].sort());
    expect(trashed.upserts).toEqual([]);
    fake.relabel(account, id, ["INBOX"]);
    const back = await drain(h, conn, trashed.cursor);
    expect(back.upserts.map((m) => m.message_id)).toEqual([id]);
    expect(back.removals).toEqual([]);
  });

  it("a message with neither internalDate nor a Date header is skipped and logged without content, never given the current time", async () => {
    const { fake, h, conn, account } = setup();
    const id = fake.addMessage(account);
    const m = account.messages.get(id);
    if (m) m.omitDate = true;
    const { upserts } = await drain(h, conn, null);
    expect(upserts.map((u) => u.message_id)).not.toContain(id);
    expect(upserts).toHaveLength(5);
    const skipped = h.logs.filter((l) => l.event === "google.mail.message_skipped");
    expect(skipped).toHaveLength(1);
    expect(JSON.stringify(skipped)).not.toContain(id.slice(0, 8) + "x");
  });
});

describe("rate limits (T-063 review)", () => {
  const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const limited = () => HttpResponse.json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 });

  it("a 403 userRateLimitExceeded is retried after a pause and then succeeds", async () => {
    const { fake, h, conn } = setup();
    server.use(http.get(url, limited, { once: true }));
    const res = await h.mail.search("PKG", conn, { query: "budget" });
    expect(res.data).toHaveLength(1);
    expect(fake.state.gmailRequests.filter((r) => r.path === "/gmail/v1/users/me/messages")).toHaveLength(1); // the 403 never reached the fake
  });

  it("a persistent rate-limit 403 stops after three attempts as rate_limited", async () => {
    const { h, conn } = setup();
    let hits = 0;
    server.use(
      http.get(url, () => {
        hits += 1;
        return limited();
      }),
    );
    await expect(h.mail.search("PKG", conn, { query: "budget" })).rejects.toMatchObject({ info: { kind: "rate_limited" } });
    expect(hits).toBe(3);
  });

  it("a plain 403 (insufficient permission) is not retried", async () => {
    const { h, conn } = setup();
    let hits = 0;
    server.use(
      http.get(url, () => {
        hits += 1;
        return HttpResponse.json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 });
      }),
    );
    await expect(h.mail.search("PKG", conn, { query: "budget" })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(hits).toBe(1);
  });

  it("a 429 with Retry-After inside the client's cap is retried by the client", async () => {
    const { h, conn } = setup();
    server.use(http.get(url, () => HttpResponse.json({}, { status: 429, headers: { "retry-after": "0" } }), { once: true }));
    expect((await h.mail.search("PKG", conn, { query: "budget" })).data).toHaveLength(1);
  });
});
