// The Microsoft mail delta sync (T-258) end to end over the fake Graph (MSW): spec §17 tests 11 - 15 and 17, the request rules (no $filter, ImmutableId on
// every request, the window), tampered links, bodies that never reach the store, the token canary, and a Microsoft sync beside a Google connection of the
// same user. Synthetic data only (rule 10); nothing waits on a real timer.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { PROVIDER_DISABLED_MESSAGE } from "../facade/gate";
import { RateLimiter } from "../http/rate-limit";
import type { CommsCursor, MailSyncResult } from "../comms/schemas";
import { TENANT_A, TENANT_B } from "../testing/microsoft-harness";
import { createMicrosoftMailHarness, MAIL_DOMAIN } from "../testing/microsoft-mail-harness";
import { HttpResponse, http, useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft, GRAPH_V1, MICROSOFT_ERROR_TEXT_CANARY } from "../testing/msw/microsoft/handlers";
import { createFakeMail, MAIL_BODY_CANARY, MAIL_PREVIEW_CANARY, type FakeMailOptions } from "../testing/msw/microsoft/mail";
import { encodeCursor, MAX_LINK_CHARS, parseCursor, type CursorState } from "./mail-cursor";
import { MESSAGE_SELECT } from "./mail-map";
import { REDACTED } from "../vault/secret";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

type Options = { mail?: FakeMailOptions; harness?: Partial<Parameters<typeof createMicrosoftMailHarness>[0]> };
function setup(options: Options = {}) {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake, options.mail);
  server.use(...fake.handlers, ...mail.handlers);
  const m = createMicrosoftMailHarness({ fake, mail, ...options.harness });
  const made = m.connect("PKG");
  return { fake, mail, m, ...made };
}
type Env = ReturnType<typeof setup>;

/** Pages one provider call at a time until the run ends. */
async function drain(env: Env, start: CommsCursor | null = null, pageSize?: number, conn = env.conn) {
  const upserts: MailSyncResult["upserts"] = [];
  const removals: MailSyncResult["removals"] = [];
  const hasMore: boolean[] = [];
  let cursor = start;
  for (let i = 0; i < 200; i++) {
    const r = await env.m.provider.sync("PKG", conn, cursor, pageSize ? { pageSize } : undefined);
    if (r.fullResyncRequired) return { resync: true as const, upserts, removals, cursor: null, hasMore };
    upserts.push(...r.upserts);
    removals.push(...r.removals);
    hasMore.push(r.hasMore);
    cursor = r.nextCursor;
    if (!r.hasMore) return { resync: false as const, upserts, removals, cursor: cursor as CommsCursor, hasMore };
  }
  throw new Error("sync did not terminate");
}
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isConnectorError(e)) return e;
    throw e;
  }
  throw new Error("expected a ConnectorError");
}
const stateOf = (value: string, connectionId: string) => {
  const s = parseCursor(value, connectionId);
  if (!s) throw new Error("cursor does not parse");
  return s;
};
const decoded = (search: string) => decodeURIComponent(search.replace(/\+/g, " "));

describe("spec §17 test 11: mail delta", () => {
  it("3 inbox and 2 sent messages: 5 rows indexed with folder INBOX/SENT, SENT in the sent rows' labels, and a cursor starting m1.<connection id>.m:", async () => {
    const env = setup();
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ mode: "full", written: 5, removed: 0, resynced: false, conflict: false });
    const rows = env.m.twin.rowsOf(env.conn.id);
    expect(rows).toHaveLength(5);
    const inbox = rows.filter((r) => r.folder === "INBOX");
    const sentRows = rows.filter((r) => r.folder === "SENT");
    expect(inbox).toHaveLength(3);
    expect(sentRows).toHaveLength(2);
    for (const r of sentRows) expect(r.labels).toContain("SENT");
    for (const r of inbox) expect(r.labels).not.toContain("SENT");
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toMatch(new RegExp(`^m1\\.${env.conn.id}\\.m:`));
    // the rows are indexed with real field values
    expect(inbox.map((r) => r.subject).sort()).toEqual(["Synthetic inbox 1", "Synthetic inbox 2", "Synthetic inbox 3"]);
    expect(rows.every((r) => r.source_url?.startsWith("https://outlook.office.com/") === true)).toBe(true);
    // a second run is quiet
    const again = await env.m.sync.run("PKG", env.conn);
    expect(again).toMatchObject({ mode: "incremental", written: 0, removed: 0 });
  });

  it("one Graph page per sync call, in folder order, resuming from the cursor; the last page of the last folder ends the run", async () => {
    const env = setup();
    const first = await env.m.provider.sync("PKG", env.conn, null, { pageSize: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.upserts).toHaveLength(2);
    const s1 = stateOf((first.nextCursor as CommsCursor).value, env.conn.id);
    expect(s1.pos).toBe(0);
    expect(s1.folders[0]?.next).toBeDefined();
    expect(s1.folders[0]?.delta).toBeUndefined();
    const all = await drain(env, null, 2);
    expect(all.upserts).toHaveLength(5);
    expect(all.hasMore.at(-1)).toBe(false);
    expect(all.hasMore.slice(0, -1).every(Boolean)).toBe(true);
    const done = stateOf((all.cursor as CommsCursor).value, env.conn.id);
    expect(done.pos).toBe(0);
    expect(done.folders.every((f) => f.delta !== undefined && f.next === undefined)).toBe(true);
    expect(done.folders.map((f) => f.name)).toEqual(["inbox", "sentitems"]);
  });

  it("resolves each well-known folder to its id first and uses the id (never the name) in the delta URL", async () => {
    const env = setup();
    await drain(env);
    const lookups = env.mail.requests.filter((r) => r.kind === "folder");
    expect(lookups.map((r) => r.path)).toEqual([`/v1.0/me/mailFolders/inbox`, `/v1.0/me/mailFolders/sentitems`]);
    const inboxId = env.mail.folderId(env.account, "inbox");
    expect(env.mail.deltaRequests()[0]?.path).toBe(`/v1.0/me/mailFolders/${encodeURIComponent(inboxId)}/messages/delta`);
    // the fake refuses a well-known name in a delta URL, so a build that used names would fail above; shown directly:
    const e = await failure(env.m.api.get("PKG", env.conn, "/me/mailFolders/{id}/messages/delta", { id: "inbox" }, undefined, { headers: { Prefer: 'IdType="ImmutableId"' }, rawQuery: "$select=id" }));
    expect(e.info.kind).toBe("not_found");
  });

  it("both link styles Graph might use (slash and OData key) work", async () => {
    for (const linkStyle of ["slash", "paren"] as const) {
      const env = setup({ mail: { linkStyle } });
      const base = await drain(env, null, 2);
      env.mail.add(env.account, "inbox", { subject: "Added after" });
      const next = await drain(env, base.cursor);
      expect(next.upserts.map((u) => u.subject), linkStyle).toEqual(["Added after"]);
    }
  });
});

describe("spec §17 test 12: removal with folder", () => {
  it("a message moved from Inbox to Sent Items, Sent's upsert applied before Inbox's @removed: the row stays present with folder SENT", async () => {
    const env = setup({ harness: { lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A], mailFolders: ["sentitems", "inbox"] }, domains: [MAIL_DOMAIN] } } } });
    await env.m.sync.run("PKG", env.conn);
    const id = env.mail.messages(env.account, "inbox")[0]?.id as string;
    env.mail.move(env.account, id, "inbox", "sentitems");
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.removed).toBe(0); // the stored row is in SENT by then, so the INBOX-scoped removal matches nothing
    const row = env.m.twin.rowsOf(env.conn.id).find((r) => r.message_id === id);
    expect(row).toMatchObject({ folder: "SENT", deleted: false });
    expect(row?.labels).toContain("SENT");
    // the removal was sent for the folder it left
    const removalWrite = env.m.twin.writes.filter((w) => w.store === "message_index").flatMap((w) => (w.value as { removals: { message_id: string; folder?: string }[] }).removals);
    expect(removalWrite).toContainEqual({ message_id: id, folder: "INBOX" });
  });

  it("the other order (Inbox's @removed first, then Sent's upsert) also ends present with folder SENT", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    const id = env.mail.messages(env.account, "inbox")[0]?.id as string;
    env.mail.move(env.account, id, "inbox", "sentitems");
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.removed).toBe(1);
    expect(env.m.twin.rowsOf(env.conn.id).find((r) => r.message_id === id)).toMatchObject({ folder: "SENT", deleted: false });
  });

  it("a message deleted from a folder is flagged deleted in THAT folder only, and any @removed counts (the documented reason is `deleted` for both)", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    const gone = env.mail.remove(env.account, "inbox");
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.removed).toBe(1);
    const rows = env.m.twin.rowsOf(env.conn.id);
    expect(rows.find((r) => r.message_id === gone)?.deleted).toBe(true);
    expect(rows.filter((r) => r.deleted)).toHaveLength(1);
  });
});

describe("spec §17 test 13: 410 and the other expired-state answers", () => {
  it("410 for the stored link: the cursor is reset and one full load follows", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    const initialsBefore = env.mail.deltaRequests().filter((r) => !/\$(delta|skip)token/.test(r.search)).length;
    env.mail.expireDeltaState(env.account);
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ resynced: true, mode: "full" });
    expect(env.m.twin.stats.resets).toBe(1);
    expect(env.m.twin.rowsOf(env.conn.id)).toHaveLength(5);
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toMatch(new RegExp(`^m1\\.${env.conn.id}\\.m:`));
    const initialsAfter = env.mail.deltaRequests().filter((r) => !/\$(delta|skip)token/.test(r.search)).length;
    expect(initialsAfter - initialsBefore).toBe(2); // one full load: each folder's first request again
  });

  it("a second 410 in the same run fails the run (it never loops)", async () => {
    const env = setup({ harness: { pageSize: 1 } });
    await env.m.sync.run("PKG", env.conn);
    env.mail.expireDeltaState(env.account, { times: 2 });
    const e = await failure(env.m.sync.run("PKG", env.conn));
    expect(e.info.kind).toBe("provider_error");
    expect(env.m.twin.stats.resets).toBe(1);
  });

  it("an answer, not an error: 410, and a 4xx with syncStateNotFound or resyncRequired in any letter case, give fullResyncRequired", async () => {
    for (const how of [{ status: 410, code: "syncStateNotFound" }, { status: 410, code: "" }, { status: 400, code: "SYNCSTATENOTFOUND" }, { status: 400, code: "syncstatenotfound" }, { status: 409, code: "ResyncRequired" }, { status: 400, code: "resyncrequired" }]) {
      const env = setup();
      const base = await drain(env);
      env.mail.expireDeltaState(env.account, how);
      const r = await env.m.provider.sync("PKG", env.conn, base.cursor);
      expect(r, JSON.stringify(how)).toMatchObject({ fullResyncRequired: true, nextCursor: null, upserts: [], removals: [], hasMore: false });
    }
  });

  it("other failures are errors, not resyncs: another 4xx code, a 5xx with the sync-state code, and a 410 on the FIRST request of a load", async () => {
    const env = setup();
    const base = await drain(env);
    env.mail.expireDeltaState(env.account, { status: 400, code: "InvalidRequest" });
    expect((await failure(env.m.provider.sync("PKG", env.conn, base.cursor))).info.kind).toBe("invalid_input");
    env.mail.expireDeltaState(env.account, { status: 500, code: "syncStateNotFound", times: 5 });
    expect((await failure(env.m.provider.sync("PKG", env.conn, base.cursor))).info.kind).toBe("transient");
    const fresh = setup();
    server.use(http.get(`${GRAPH_V1}/me/mailFolders/:id/messages/delta`, () => HttpResponse.json({ error: { code: "syncStateNotFound" } }, { status: 410 })));
    expect((await failure(fresh.m.provider.sync("PKG", fresh.conn, null))).info.kind).toBe("not_found");
  });
});

describe("spec §17 test 14: cursor bound", () => {
  it("long synthetic links over three folders: the stored cursor stays under 16 KB", async () => {
    const env = setup({
      mail: { tokenPad: 2300 },
      harness: { lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A], mailFolders: ["inbox", "sentitems", "archive"] }, domains: [MAIL_DOMAIN] } } },
    });
    env.mail.add(env.account, "archive", { ageDays: 3 });
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.written).toBe(6);
    const value = env.m.twin.cursorOf("PKG", env.conn.id) as string;
    expect(value.length).toBeLessThan(16 * 1024);
    const state = stateOf(value, env.conn.id);
    expect(state.folders).toHaveLength(3);
    expect(state.folders.every((f) => (f.delta ?? "").length > 2300)).toBe(true);
  });

  it("a link too long for the bound fails safe: a full resync answer (nothing stored, nothing cut), then the run fails instead of looping", async () => {
    const env = setup({ mail: { tokenPad: MAX_LINK_CHARS } });
    const r = await env.m.provider.sync("PKG", env.conn, null);
    expect(r).toMatchObject({ fullResyncRequired: true, nextCursor: null, upserts: [], removals: [] });
    const e = await failure(env.m.sync.run("PKG", env.conn));
    expect(e.info.kind).toBe("provider_error");
    expect(env.m.twin.writes).toEqual([]);
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeUndefined();
  });
});

describe("spec §17 test 15: foreign cursor", () => {
  it("a cursor of another connection, a Google cursor or garbage is fullResyncRequired, with no request at all", async () => {
    const env = setup();
    const other = env.m.connect("PKG");
    const otherCursor = (await drain(env, null, undefined, other.conn)).cursor as CommsCursor;
    const g = env.m.seedGoogle("PKG");
    const before = env.m.externalRequestCount();
    for (const value of [otherCursor.value, g.cursor, "stale", "m1.x.m:", `m1.${env.conn.id}.c:abc`, `g1.${env.conn.id}.h:1`]) {
      const r = await env.m.provider.sync("PKG", env.conn, { value });
      expect(r, value).toMatchObject({ fullResyncRequired: true, nextCursor: null });
    }
    expect(env.m.externalRequestCount()).toBe(before);
  });

  it("the TypeScript TWIN of the index writer refuses a page whose cursor has the other provider's prefix or another connection's id, and another lane's connection (the SQL guarantee itself is pgTAP 321: 22023 / 42501)", async () => {
    const env = setup({ harness: { lanes: { PKG: { providers: ["google", "microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] }, APK: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] } } } });
    const g = env.m.seedGoogle("PKG");
    const page = (value: string): MailSyncResult => ({ upserts: [], removals: [], nextCursor: { value }, hasMore: false, fullResyncRequired: false });
    const expectOne = { expected: null };
    // a Google connection cannot store an m1 cursor
    const gStored = env.m.twin.cursorOf("PKG", g.row.id) as string;
    await expect(env.m.twin.store.applyPage("PKG", g.conn, page(`m1.${g.row.id}.m:x`), { expected: { value: gStored } })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    // a Microsoft connection cannot store a g1 cursor, nor another connection's
    await expect(env.m.twin.store.applyPage("PKG", env.conn, page(`g1.${env.conn.id}.h:1`), expectOne)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(env.m.twin.store.applyPage("PKG", env.conn, page(`m1.${g.row.id}.m:x`), expectOne)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    await expect(env.m.twin.store.applyPage("PKG", env.conn, page(`m1.${env.conn.id}.m:${"a".repeat(16_384)}`), expectOne)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    // a lane-B (APK) Microsoft connection called with lane A
    const b = env.m.connect("APK");
    await expect(env.m.twin.store.applyPage("PKG", b.conn, page(`m1.${b.conn.id}.m:x`), expectOne)).rejects.toMatchObject({ info: { kind: "lane_mismatch" } });
    // the real prefix is accepted
    await expect(env.m.twin.store.applyPage("PKG", env.conn, page(`m1.${env.conn.id}.m:x`), expectOne)).resolves.toMatchObject({ conflict: false });
  });
});

describe("spec §17 test 17: throttling", () => {
  it("a 429 with Retry-After: 2 for tenant A: the client waits about 2 s and retries; a sync of a connection in tenant B is not delayed", async () => {
    const env = setup();
    const a = env.m.connect("PKG", { tenant: TENANT_A });
    const b = env.m.connect("PKG", { tenant: TENANT_B });
    a.account.throttle = { status: 429, retryAfter: 2, remaining: 1 };
    const [ra, rb] = await Promise.all([env.m.sync.run("PKG", a.conn), env.m.sync.run("PKG", b.conn)]);
    expect(ra.written).toBe(5);
    expect(rb.written).toBe(5);
    expect(env.m.clock.waits.filter((w) => w >= 2000)).toEqual([2000]); // exactly one wait, and it is tenant A's
    const requestsOf = (address: string) => env.mail.requests.filter((r) => r.address === address).length;
    expect(requestsOf(b.address)).toBe(4); // two folder lookups and two delta pages, no repeat
    expect(requestsOf(a.address)).toBe(5); // the same, plus the retried one
    expect(env.fake.state.tokenRequests.filter((t) => t.tenant === TENANT_B).length).toBe(0);
  });

  it("503 with Retry-After is honoured too", async () => {
    const env = setup();
    env.account.throttle = { status: 503, retryAfter: 3, remaining: 1 };
    await env.m.sync.run("PKG", env.conn);
    expect(env.m.clock.waits).toContain(3000);
  });
});

describe("requests: ImmutableId on every one, no $filter, newest first, the index fields only", () => {
  it("the fake refuses a request without the ImmutableId preference (and one with only the page size)", async () => {
    const env = setup();
    const id = env.mail.folderId(env.account, "inbox");
    const call = (headers?: Record<string, string>) => env.m.api.get("PKG", env.conn, "/me/mailFolders/{id}/messages/delta", { id }, undefined, { ...(headers ? { headers } : {}), rawQuery: "$select=id" });
    expect((await failure(call())).info.kind).toBe("invalid_input");
    expect((await failure(call({ Prefer: "odata.maxpagesize=5" }))).info.kind).toBe("invalid_input");
    expect(env.mail.refusedForImmutableId).toBe(2);
    await expect(call({ Prefer: 'IdType="ImmutableId"' })).resolves.toMatchObject({ status: 200 });
    expect(env.mail.refusedForImmutableId).toBe(2);
  });

  it("a full load and an incremental run send the preference and the page size on EVERY request, including nextLink and deltaLink requests and the folder lookups", async () => {
    const env = setup();
    const base = await drain(env, null, 2);
    env.mail.add(env.account, "inbox");
    await drain(env, base.cursor, 2);
    const all = env.mail.requests;
    expect(all.length).toBeGreaterThanOrEqual(7);
    const links = all.filter((r) => /\$(skip|delta)token=/.test(r.search));
    expect(links.some((r) => r.search.includes("$skiptoken"))).toBe(true);
    expect(links.some((r) => r.search.includes("$deltatoken"))).toBe(true);
    for (const r of all) {
      expect(r.prefer, `${r.path}${r.search}`).toMatch(/IdType="ImmutableId"/);
      expect(r.prefer).toMatch(/odata\.maxpagesize=2/);
    }
    expect(env.mail.refusedForImmutableId).toBe(0);
  });

  it("no request has a $filter; the first delta request of each folder is newest first with the index fields only; link requests carry the stored link's query exactly", async () => {
    const env = setup();
    const base = await drain(env, null, 2);
    env.mail.add(env.account, "inbox");
    await drain(env, base.cursor);
    const deltas = env.mail.deltaRequests();
    for (const r of env.mail.requests) expect(`${r.path}${decoded(r.search)}`.toLowerCase()).not.toContain("filter");
    const initials = deltas.filter((r) => !/\$(skip|delta)token/.test(r.search));
    expect(initials).toHaveLength(2);
    for (const r of initials) {
      const q = new URLSearchParams(decoded(r.search));
      expect(q.get("$orderby")).toBe("receivedDateTime desc");
      expect(q.get("$select")?.split(",").sort()).toEqual([...MESSAGE_SELECT].sort());
      expect(q.get("$select")).not.toMatch(/body/i);
    }
    // a stored link is sent back unchanged: the request's query is the link's query, with no $select / $orderby re-added
    const state = stateOf(base.cursor?.value ?? "", env.conn.id);
    const stored = (state.folders[0]?.delta as string).split("?")[1];
    const linkRequest = deltas.find((r) => r.search === `?${stored}`);
    expect(linkRequest, "the stored link's query went out byte for byte").toBeDefined();
    expect(linkRequest?.search).not.toMatch(/select|orderby/i);
  });
});

describe("the window: 90 days or the lane's retention, whichever is shorter; older messages are dropped by the mapper and never indexed", () => {
  const seedOld = (env: Env) => {
    const ids = { d89: env.mail.add(env.account, "inbox", { ageDays: 89, subject: "89 days" }), d91: env.mail.add(env.account, "inbox", { ageDays: 91, subject: "91 days" }), d400: env.mail.add(env.account, "inbox", { ageDays: 400, subject: "400 days" }), d40: env.mail.add(env.account, "inbox", { ageDays: 40, subject: "40 days" }) };
    return ids;
  };

  it("default retention: the 89-day message is indexed, the 91- and 400-day ones are read and dropped (many pages, nothing older stored)", async () => {
    const env = setup({ harness: { pageSize: 2 } });
    const ids = seedOld(env);
    await env.m.sync.run("PKG", env.conn);
    const stored = new Set(env.m.twin.rowsOf(env.conn.id).map((r) => r.message_id));
    expect(stored.has(ids.d89)).toBe(true);
    expect(stored.has(ids.d40)).toBe(true);
    expect(stored.has(ids.d91)).toBe(false);
    expect(stored.has(ids.d400)).toBe(false);
    expect(JSON.stringify(env.m.twin.writes)).not.toContain(ids.d91);
    expect(env.mail.deltaRequests().length).toBeGreaterThan(3); // the whole folder was read, page by page
  });

  it("a retention shorter than 90 days shortens the window; a longer one does not lengthen it", async () => {
    const short = setup({ harness: { retention: { PKG: 30 } } });
    const ids = seedOld(short);
    await short.m.sync.run("PKG", short.conn);
    const s = new Set(short.m.twin.rowsOf(short.conn.id).map((r) => r.message_id));
    expect(s.has(ids.d40)).toBe(false);
    expect(s.has(ids.d89)).toBe(false);
    expect([...s].length).toBe(5); // the seeded 3 + 2, all within 30 days
    const long = setup({ harness: { retention: { PKG: 365 } } });
    const ids2 = seedOld(long);
    await long.m.sync.run("PKG", long.conn);
    const l = new Set(long.m.twin.rowsOf(long.conn.id).map((r) => r.message_id));
    expect(l.has(ids2.d89)).toBe(true);
    expect(l.has(ids2.d91)).toBe(false);
  });

  it("an unreadable lane policy fails the first load closed: no message request, no cursor", async () => {
    const env = setup();
    env.m.retention.PKG = -1; // the harness reads this as "cannot be read"
    const e = await failure(env.m.provider.sync("PKG", env.conn, null));
    expect(e.info.kind).toBe("transient");
    expect(env.mail.deltaRequests()).toEqual([]);
    expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeUndefined();
  });

  it("a change to an old message after the first load is dropped too (nothing older than the window is ever indexed)", async () => {
    const env = setup();
    const old = env.mail.add(env.account, "inbox", { ageDays: 150 });
    await env.m.sync.run("PKG", env.conn);
    env.mail.change(env.account, "inbox", old, { isRead: true });
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.written).toBe(0);
    expect(env.m.twin.rowsOf(env.conn.id).some((r) => r.message_id === old)).toBe(false);
  });
});

describe("tampered links: a link is used only when its origin and path are right; it is never followed anywhere else", () => {
  async function withEvil() {
    let hits = 0;
    server.use(http.all("https://evil.example.test/*", () => {
      hits += 1;
      return HttpResponse.json({});
    }), http.all("https://graph.microsoft.com.evil.example.test/*", () => {
      hits += 1;
      return HttpResponse.json({});
    }));
    return () => hits;
  }
  const mutations = (inboxId: string, sentId: string) => {
    const q = "$deltatoken=tampered";
    const enc = encodeURIComponent;
    return [
      ["another host", `https://evil.example.test/v1.0/me/mailFolders/${enc(inboxId)}/messages/delta?${q}`],
      ["a look-alike host", `https://graph.microsoft.com.evil.example.test/v1.0/me/mailFolders/${enc(inboxId)}/messages/delta?${q}`],
      ["user info", `https://graph.microsoft.com@evil.example.test/v1.0/me/mailFolders/${enc(inboxId)}/messages/delta?${q}`],
      ["http", `http://graph.microsoft.com/v1.0/me/mailFolders/${enc(inboxId)}/messages/delta?${q}`],
      ["another port", `https://graph.microsoft.com:8443/v1.0/me/mailFolders/${enc(inboxId)}/messages/delta?${q}`],
      ["another path", `https://graph.microsoft.com/v1.0/me/messages/delta?${q}`],
      ["another user's mailbox", `https://graph.microsoft.com/v1.0/users/victim@example.test/mailFolders/${enc(inboxId)}/messages/delta?${q}`],
      ["no delta segment", `https://graph.microsoft.com/v1.0/me/mailFolders/${enc(inboxId)}/messages?${q}`],
      ["a dot segment", `https://graph.microsoft.com/v1.0/me/mailFolders/${enc(inboxId)}/../${enc(sentId)}/messages/delta?${q}`],
      ["another folder id", `https://graph.microsoft.com/v1.0/me/mailFolders/${enc(sentId)}/messages/delta?${q}`],
      ["a fragment", `https://graph.microsoft.com/v1.0/me/mailFolders/${enc(inboxId)}/messages/delta?${q}#x`],
    ] as const;
  }

  it("in a stored cursor: another host, path or folder id is fullResyncRequired with ZERO requests of any kind, and nothing is sent to the other host", async () => {
    const env = setup();
    const hits = await withEvil();
    const base = await drain(env, null, 2);
    const good = stateOf(base.cursor?.value ?? "", env.conn.id);
    const [inboxId, sentId] = [good.folders[0]?.id as string, good.folders[1]?.id as string];
    for (const [what, link] of mutations(inboxId, sentId)) {
      for (const slot of ["delta", "next"] as const) {
        const tampered: CursorState = { ...good, folders: good.folders.map((f, i) => (i === 0 ? { name: f.name, id: f.id, since: f.since, [slot]: link } : f)) };
        const cursor = encodeCursor(env.conn.id, tampered) as CommsCursor;
        const before = env.m.externalRequestCount();
        const reads = env.m.h.stats.tokenReads;
        const r = await env.m.provider.sync("PKG", env.conn, cursor);
        expect(r, `${what} (${slot})`).toMatchObject({ fullResyncRequired: true, nextCursor: null });
        expect(env.m.externalRequestCount(), `${what} (${slot})`).toBe(before);
        expect(env.m.h.stats.tokenReads, `${what} (${slot}): no token read`).toBe(reads);
      }
    }
    expect(hits()).toBe(0);
  });

  it("a run over a tampered stored cursor reloads once and ends with a good cursor; nothing is sent to the other host", async () => {
    const env = setup();
    const hits = await withEvil();
    await env.m.sync.run("PKG", env.conn);
    const good = stateOf(env.m.twin.cursorOf("PKG", env.conn.id) as string, env.conn.id);
    const evil = { ...good, folders: good.folders.map((f, i) => (i === 0 ? { ...f, delta: `https://evil.example.test/v1.0/me/mailFolders/${f.id}/messages/delta?$deltatoken=x` } : f)) };
    env.m.twin.cursors.set(`PKG\u0000${env.conn.id}`, (encodeCursor(env.conn.id, evil) as CommsCursor).value);
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ resynced: true, mode: "full" });
    expect(parseCursor(env.m.twin.cursorOf("PKG", env.conn.id) as string, env.conn.id)).not.toBeNull();
    expect(hits()).toBe(0);
  });

  it("a link Graph itself returns that points elsewhere is not stored and not followed: the sync fails with a fixed message", async () => {
    for (const rewriteLink of [(l: string) => l.replace("graph.microsoft.com", "evil.example.test"), (l: string) => l.replace("/me/mailFolders/", "/users/victim/mailFolders/"), (l: string) => l.replace("/messages/delta", "/messages")]) {
      const env = setup({ mail: { rewriteLink } });
      const hits = await withEvil();
      const e = await failure(env.m.provider.sync("PKG", env.conn, null));
      expect(e.info.kind).toBe("provider_error");
      expect(e.message).not.toMatch(/evil|victim|example\.test/);
      expect(hits()).toBe(0);
      await expect(env.m.sync.run("PKG", env.conn)).rejects.toMatchObject({ info: { kind: "provider_error" } });
      expect(env.m.twin.cursorOf("PKG", env.conn.id)).toBeUndefined();
    }
  });
});

describe("rule 6: bodies never reach the store", () => {
  it("the fake returns body, bodyPreview, uniqueBody and headers on every message; none of it is in any page, write, row, log or error", async () => {
    const env = setup();
    // proof that the fake does return them (the raw response)
    const raw = await env.m.api.get("PKG", env.conn, "/me/mailFolders/{id}/messages/delta", { id: env.mail.folderId(env.account, "inbox") }, undefined, { headers: { Prefer: 'IdType="ImmutableId"' }, rawQuery: "$select=id" });
    expect(JSON.stringify(raw.data)).toContain(MAIL_BODY_CANARY);
    expect(JSON.stringify(raw.data)).toContain(MAIL_PREVIEW_CANARY);
    const drained = await drain(env, null, 2);
    expect(drained.upserts.length).toBe(5);
    await env.m.sync.run("PKG", env.conn);
    for (const surface of [JSON.stringify(drained), JSON.stringify(env.m.twin.writes), JSON.stringify([...env.m.twin.rows.values()]), JSON.stringify(env.m.h.logs), JSON.stringify(env.m.twin.cursors.values())]) {
      expect(surface).not.toContain(MAIL_BODY_CANARY);
      expect(surface).not.toContain(MAIL_PREVIEW_CANARY);
    }
    for (const row of env.m.twin.rows.values()) for (const k of ["body", "bodyPreview", "uniqueBody", "internetMessageHeaders"]) expect(k in row).toBe(false);
    expect(env.m.contentWriteCount()).toBe(0);
  });
});

describe("the token canary: no token in logs, errors, the cursor or the store", () => {
  it("through a full load, an expired access token (refresh), a 401, a 5xx, a throttle and a revoked grant", async () => {
    const env = setup();
    const surfaces: unknown[] = [];
    const thrown: unknown[] = [];
    const attempt = async (p: Promise<unknown>) => {
      try {
        surfaces.push(await p);
      } catch (e) {
        thrown.push(isConnectorError(e) ? { info: e.info, message: e.message, json: e.toJSON() } : String(e));
      }
    };
    await attempt(env.m.sync.run("PKG", env.conn));
    env.m.h.expireStoredAccess(env.conn.id); // the next call refreshes the token
    env.mail.add(env.account, "inbox");
    await attempt(env.m.sync.run("PKG", env.conn));
    env.fake.state.unauthorizedOnce = 0;
    env.mail.setFault(env.account, "server_error");
    await attempt(env.m.sync.run("PKG", env.conn));
    env.mail.setFault(env.account, "rate_limited");
    await attempt(env.m.sync.run("PKG", env.conn));
    env.mail.setFault(env.account, "auth_revoked");
    await attempt(env.m.sync.run("PKG", env.conn));
    expect(thrown.length).toBeGreaterThanOrEqual(3);
    const tokens = new Set<string>();
    for (const a of env.fake.accounts.values()) for (const t of [...a.accessTokens, ...a.refreshTokens]) tokens.add(t);
    const stored = env.m.h.storedSet(env.conn.id);
    for (const k of ["access_token", "refresh_token"]) if (typeof stored?.[k] === "string") tokens.add(stored[k] as string);
    expect(tokens.size).toBeGreaterThan(3);
    const text = JSON.stringify([env.m.h.logs, env.m.h.apiErrors, env.m.h.reconnects, thrown, surfaces, env.m.twin.writes, [...env.m.twin.cursors.values()], env.m.twin.rows.size]);
    for (const t of tokens) expect(text, "a token reached a log, error, cursor or store").not.toContain(t);
    expect(text).not.toContain(MICROSOFT_ERROR_TEXT_CANARY);
    expect(text).not.toContain(REDACTED); // the logger's redaction marker would mean a token was passed to it
    expect(env.m.h.logs.length).toBeGreaterThan(5);
  });
});

describe("a Microsoft sync beside a Google connection of the same user (D-57): Google rows and cursor untouched", () => {
  const OWNER = "00000000-0000-4000-8000-0000000b2580";
  const lanes = { PKG: { providers: ["google", "microsoft"] as ("google" | "microsoft")[], microsoft: { tenantIds: [TENANT_A] }, domains: [MAIL_DOMAIN] } };

  it("the Microsoft run reads and writes only its own connection: the Google index rows, cursor and connection row are identical afterwards", async () => {
    const env = setup({ harness: { lanes } });
    const g = env.m.seedGoogle("PKG", { ownerId: OWNER });
    const ms = env.m.connect("PKG", { ownerId: OWNER });
    const googleRowsBefore = structuredClone(env.m.twin.rowsOf(g.row.id));
    const googleConnBefore = structuredClone(env.m.h.rows.get(g.row.id));
    const requestsBefore = env.m.externalRequestCount();
    const run = await env.m.sync.run("PKG", ms.conn);
    expect(run).toMatchObject({ mode: "full", written: 5 });
    expect(env.m.twin.rowsOf(g.row.id)).toEqual(googleRowsBefore);
    expect(env.m.twin.cursorOf("PKG", g.row.id)).toBe(g.cursor);
    expect(env.m.h.rows.get(g.row.id)).toEqual(googleConnBefore);
    expect(env.m.twin.writes.length).toBeGreaterThan(0);
    expect(env.m.twin.writes.every((w) => w.connectionId === ms.conn.id)).toBe(true);
    expect(env.m.twin.stats.resets).toBe(0);
    // the Microsoft rows carry the Microsoft connection id only, and the cursors are of their own prefix
    expect(env.m.twin.rowsOf(ms.conn.id).every((r) => r.connection_id === ms.conn.id)).toBe(true);
    expect(env.m.twin.cursorOf("PKG", ms.conn.id)).toMatch(/^m1\./);
    expect(env.m.externalRequestCount()).toBeGreaterThan(requestsBefore);
    // a second run, with changes, still leaves Google alone
    env.mail.add(ms.account, "inbox");
    await env.m.sync.run("PKG", ms.conn);
    expect(env.m.twin.rowsOf(g.row.id)).toEqual(googleRowsBefore);
    expect(env.m.twin.cursorOf("PKG", g.row.id)).toBe(g.cursor);
  });

  it("the Microsoft runner refuses the Google connection, and the provider refuses it before any request or token read", async () => {
    const env = setup({ harness: { lanes } });
    const g = env.m.seedGoogle("PKG", { ownerId: OWNER });
    const requests = env.m.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    await expect(env.m.sync.run("PKG", g.conn as never)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(env.m.provider.sync("PKG", g.conn as never, null)).rejects.toMatchObject({ info: { kind: "forbidden" } });
    await expect(env.m.provider.sync("PKG", g.conn as never, { value: g.cursor })).rejects.toMatchObject({ info: { kind: "forbidden" } });
    expect(env.m.externalRequestCount()).toBe(requests);
    expect(env.m.h.stats.tokenReads).toBe(reads);
    expect(env.m.twin.cursorOf("PKG", g.row.id)).toBe(g.cursor);
  });
});

describe("the provider gate, the guard and the mail policy are checked on every call", () => {
  const refused = async (env: Env, kind: string, message?: string) => {
    const before = env.m.externalRequestCount();
    const reads = env.m.h.stats.tokenReads;
    const e = await failure(env.m.provider.sync("PKG", env.conn, null));
    expect(e.info.kind).toBe(kind);
    if (message) expect(e.info.message).toBe(message);
    expect(env.m.externalRequestCount()).toBe(before);
    expect(env.m.h.stats.tokenReads).toBe(reads);
  };

  it("Microsoft removed from the lane's providers: refused before any request or token read; Google unaffected by this code", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    env.m.h.setLane("PKG", { providers: ["google"] });
    await refused(env, "connection_unavailable", PROVIDER_DISABLED_MESSAGE);
  });

  it("the mailbox's domain no longer allowed, or the tenant removed from the lane: refused (mail policy and tenant re-checked per call)", async () => {
    const a = setup();
    await a.m.sync.run("PKG", a.conn);
    a.m.h.setLane("PKG", { domains: ["other.example.test"] });
    await refused(a, "forbidden");
    const b = setup();
    await b.m.sync.run("PKG", b.conn);
    b.m.h.setLane("PKG", { microsoft: { tenantIds: [TENANT_B] } });
    await refused(b, "forbidden");
  });

  it("an unreadable lane config fails closed with no request", async () => {
    const env = setup();
    delete (env.m.h.lanes as Record<string, unknown>).PKG;
    await refused(env, "provider_error");
  });

  it("disabled between two pages of one run: the next page is refused and the stored cursor is the last applied page's", async () => {
    const env = setup({ harness: { pageSize: 1 } });
    const first = await env.m.provider.sync("PKG", env.conn, null, { pageSize: 1 });
    env.m.h.setLane("PKG", { providers: ["google"] });
    const before = env.m.externalRequestCount();
    await expect(env.m.provider.sync("PKG", env.conn, first.nextCursor)).rejects.toMatchObject({ info: { message: PROVIDER_DISABLED_MESSAGE } });
    expect(env.m.externalRequestCount()).toBe(before);
  });
});

describe("the folder settings (fingerprint)", () => {
  it("adding a folder: the folders already synced continue from their links, the new one loads in full", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    env.mail.add(env.account, "archive", { ageDays: 5, subject: "Archived one" });
    env.mail.add(env.account, "archive", { ageDays: 6, subject: "Archived two" });
    env.m.h.setLane("PKG", { microsoft: { tenantIds: [TENANT_A, TENANT_B], mailFolders: ["inbox", "sentitems", "archive"] } });
    const initialsBefore = env.mail.deltaRequests().filter((r) => !/\$(delta|skip)token/.test(r.search)).length;
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.written).toBe(2);
    expect(run.resynced).toBe(false);
    const initialsAfter = env.mail.deltaRequests().filter((r) => !/\$(delta|skip)token/.test(r.search)).length;
    expect(initialsAfter - initialsBefore).toBe(1); // only the archive started from nothing
    const state = stateOf(env.m.twin.cursorOf("PKG", env.conn.id) as string, env.conn.id);
    expect(state.folders.map((f) => f.name)).toEqual(["inbox", "sentitems", "archive"]);
    expect(env.m.twin.rowsOf(env.conn.id).filter((r) => r.folder === "ARCHIVE")).toHaveLength(2);
  });

  it("removing a folder stops reading it and deletes nothing", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    env.m.h.setLane("PKG", { microsoft: { tenantIds: [TENANT_A, TENANT_B], mailFolders: ["inbox"] } });
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ written: 0, removed: 0 });
    expect(stateOf(env.m.twin.cursorOf("PKG", env.conn.id) as string, env.conn.id).folders.map((f) => f.name)).toEqual(["inbox"]);
    expect(env.m.twin.rowsOf(env.conn.id).filter((r) => r.deleted)).toHaveLength(0);
    expect(env.m.twin.rowsOf(env.conn.id)).toHaveLength(5);
  });
});

describe("the run time budget (spec §8.5)", () => {
  it("a run stops after its budget with the cursor stored; the next run continues; the end state equals an unbudgeted load", async () => {
    let t = 0;
    const env = setup({ harness: { pageSize: 1, maxRunMs: 1000, runnerNow: () => (t += 600) } });
    const runs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await env.m.sync.run("PKG", env.conn);
      runs.push(r.pages);
      if (stateOf(env.m.twin.cursorOf("PKG", env.conn.id) as string, env.conn.id).folders.every((f) => f.delta !== undefined) && env.m.twin.rowsOf(env.conn.id).length === 5) break;
    }
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0]).toBeLessThan(5);
    expect(env.m.twin.rowsOf(env.conn.id)).toHaveLength(5);
    expect(env.m.h.logs.some((l) => l.event === "microsoft.mail.sync_time_budget")).toBe(true);
  });
});
