// T-258 review fixes: hostile addresses, link queries, missing optional folders, stale folder ids, small hardening items, timestamps, and the
// cases the code review found missing (empty folder, replay, folder order). Over the fake Graph; synthetic data only.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { RateLimiter } from "../http/rate-limit";
import type { CommsCursor } from "../comms/schemas";
import { createMicrosoftMailHarness, MAIL_DOMAIN } from "../testing/microsoft-mail-harness";
import { TENANT_A } from "../testing/microsoft-harness";
import { http, HttpResponse, useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMail, type FakeMailOptions } from "../testing/msw/microsoft/mail";
import { encodeCursor, isFolderId, parseCursor, validateDeltaLink, type CursorState } from "./mail-cursor";
import { mapMessage, safeWebLink, type MapContext } from "./mail-map";
import { INITIAL_QUERY, ORDERBY_PARAM, SELECT_PARAM } from "./mail-query";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
});

function setup(o: { mail?: FakeMailOptions; folders?: ("inbox" | "sentitems" | "archive")[]; harness?: Partial<Parameters<typeof createMicrosoftMailHarness>[0]> } = {}) {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake, o.mail);
  server.use(...fake.handlers, ...mail.handlers);
  const lanes = { PKG: { providers: ["microsoft" as const], microsoft: { tenantIds: [TENANT_A], mailFolders: o.folders ?? ["inbox", "sentitems"] }, domains: [MAIL_DOMAIN] } };
  const m = createMicrosoftMailHarness({ fake, mail, lanes, ...o.harness });
  return { fake, mail, m, ...m.connect("PKG") };
}
type Env = ReturnType<typeof setup>;
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isConnectorError(e)) return e;
    throw e;
  }
  throw new Error("expected a ConnectorError");
}
const stateOf = (env: Env) => {
  const s = parseCursor(env.m.twin.cursorOf("PKG", env.conn.id) as string, env.conn.id);
  if (!s) throw new Error("cursor does not parse");
  return s;
};

const SINCE = "2026-08-07T12:00:00.000Z";
const inbox: MapContext = { folder: "inbox", since: SINCE };
const msg = (over: Record<string, unknown> = {}) => ({
  id: "AAMkMessage1=",
  conversationId: "AAQkConversation1=",
  webLink: "https://outlook.office.com/owa/?ItemID=AAMk",
  from: { emailAddress: { address: "sender@sender.example.test", name: "Sender" } },
  toRecipients: [{ emailAddress: { address: "exec@pubkgroup.example.test", name: "Exec" } }],
  ccRecipients: [{ emailAddress: { address: "cc@pubkgroup.example.test" } }],
  subject: "Quarterly numbers",
  receivedDateTime: "2026-11-04T10:00:00Z",
  sentDateTime: "2026-11-04T09:59:00Z",
  isRead: false,
  flag: { flagStatus: "notFlagged" },
  importance: "normal",
  hasAttachments: false,
  inferenceClassification: "focused",
  categories: [],
  lastModifiedDateTime: "2026-11-04T10:01:00Z",
  ...over,
});
const meta = (raw: unknown, ctx: MapContext = inbox) => {
  const r = mapMessage(raw, ctx);
  if (!("meta" in r)) throw new Error(`expected a record, got ${r.dropped}`);
  return r.meta;
};

describe("item 1: a hostile address costs only that address", () => {
  const BIDI = ["‮", "‪", "⁦", "⁩", " ", " ", "\u0085", "\u0007"];
  it("a bidi or separator character in a cc address drops that address only: subject, other recipients, source_url and the row are kept", () => {
    for (const ch of BIDI) {
      const m = meta(msg({ ccRecipients: [{ emailAddress: { address: `bad${ch}@x.example.test` } }, { emailAddress: { address: "good@x.example.test" } }] }));
      expect(m.subject, JSON.stringify(ch)).toBe("Quarterly numbers");
      expect(m.cc_recipients).toEqual([{ address: "good@x.example.test" }]);
      expect(m.to_recipients).toHaveLength(1);
      expect(m.from_address).toBe("sender@sender.example.test");
      expect(m.source_url).toContain("outlook.office.com");
    }
  });
  it("the same for a To address", () => {
    const m = meta(msg({ toRecipients: [{ emailAddress: { address: "a‮b@x.example.test" } }, { emailAddress: { address: "ok@x.example.test" } }] }));
    expect(m.to_recipients).toEqual([{ address: "ok@x.example.test" }]);
    expect(m.subject).toBe("Quarterly numbers");
  });
  it("a bidi From address keeps the row with from_address null (it is never dropped as unusable)", () => {
    for (const ch of BIDI) {
      const m = meta(msg({ from: { emailAddress: { address: `s${ch}@sender.example.test`, name: "Sender" } } }));
      expect(m.from_address).toBeNull();
      expect(m.subject).toBe("Quarterly numbers");
      expect(m.to_recipients).toHaveLength(1);
    }
  });
  it("a bidi name is cleaned, not fatal", () => {
    const m = meta(msg({ from: { emailAddress: { address: "s@sender.example.test", name: "Ev‮il" } }, toRecipients: [{ emailAddress: { address: "r@x.example.test", name: "R⁦x⁩" } }] }));
    expect(m.from_name).toBe("Ev il");
    expect(m.to_recipients[0]?.name).toBe("R x");
  });
  it("a message is dropped as unusable only when it has no usable id or no usable timestamp", () => {
    expect(meta(msg({ subject: "s".repeat(998) })).subject).toHaveLength(998);
    expect(mapMessage(msg({ id: "" }), inbox)).toEqual({ dropped: "unusable" });
    expect(mapMessage(msg({ receivedDateTime: null, sentDateTime: null }), inbox)).toEqual({ dropped: "unusable" });
  });
});

describe("item 4: small hardening", () => {
  it("(a) webLink: the normalised href is stored; a backslash, %5c (any case) or non-ASCII is refused", () => {
    expect(safeWebLink("https://outlook.office.com")).toBe("https://outlook.office.com/");
    expect(safeWebLink("https://outlook.office.com/owa/?a=b")).toBe("https://outlook.office.com/owa/?a=b");
    for (const l of ["https://outlook.office.com/a\\b", "https://outlook.office.com/a%5Cb", "https://outlook.office.com/a%5cb", "https://outlook.office.com/café", "https://outlook.office.com\\@evil.example.test/", "https://outlook.office.com/‮"]) {
      expect(safeWebLink(l), l).toBeNull();
    }
  });
  it("(b) folder ids made only of dots are refused by the id check and by the cursor", () => {
    for (const id of [".", "..", "...", ""]) expect(isFolderId(id), id).toBe(false);
    expect(isFolderId("a.b")).toBe(true);
    const bad = { v: 1, folders: [{ name: "inbox", id: "..", since: SINCE }], pos: 0, fp: "inbox" };
    const conn = "00000000-0000-4000-8000-000000025801";
    expect(parseCursor(`m1.${conn}.m:${Buffer.from(JSON.stringify(bad)).toString("base64url")}`, conn)).toBeNull();
  });
  it("(b) a lookup that answers a dot id is a clean provider_error, not an invalid_input from the client on every run", async () => {
    const env = setup();
    server.use(http.get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox", () => HttpResponse.json({ id: ".." })));
    const e = await failure(env.m.provider.sync("PKG", env.conn, null));
    expect(e.info.kind).toBe("provider_error");
  });
  it("(c) a nextLink equal to the link just used is a fixed-message provider_error, not an endless loop", async () => {
    const env = setup({ harness: { pageSize: 2 } });
    const first = await env.m.provider.sync("PKG", env.conn, null, { pageSize: 2 });
    const same = (parseCursor((first.nextCursor as CommsCursor).value, env.conn.id) as CursorState).folders[0]?.next as string;
    server.use(http.get("https://graph.microsoft.com/v1.0/me/mailFolders/:id/messages/delta", () => HttpResponse.json({ value: [], "@odata.nextLink": same })));
    const e = await failure(env.m.provider.sync("PKG", env.conn, first.nextCursor));
    expect(e.info.kind).toBe("provider_error");
    expect(e.message).not.toContain("skiptoken");
  });
  it("(d) a bad raw query costs zero token reads and zero requests, before the slot and the guard", async () => {
    const env = setup();
    const before = [env.m.h.stats.tokenReads, env.m.h.stats.settingsReads, env.m.externalRequestCount()];
    for (const rawQuery of ["a=b#x", "a b", "a=b'", "a=é"]) {
      await expect(env.m.api.get("PKG", env.conn, "/me/mailFolders/{id}/messages/delta", { id: "x" }, undefined, { rawQuery })).rejects.toMatchObject({ info: { kind: "invalid_input" } });
    }
    expect([env.m.h.stats.tokenReads, env.m.h.stats.settingsReads, env.m.externalRequestCount()]).toEqual(before);
  });
});

describe("item 5: timestamps", () => {
  const at = (received: string, since = SINCE) => mapMessage(msg({ receivedDateTime: received, sentDateTime: received }), { folder: "inbox", since });
  it("Z, an offset and a zone-less string (read as UTC) give the same instant", () => {
    for (const t of ["2026-11-04T10:00:00Z", "2026-11-04T12:00:00+02:00", "2026-11-04T10:00:00", "2026-11-04T10:00:00.0000000Z", "2026-11-04T10:00:00.0000000"]) {
      expect(meta(msg({ receivedDateTime: t, sentDateTime: t })).received_at, t).toBe("2026-11-04T10:00:00.000Z");
    }
  });
  it("at the window boundary the zone decides: +02:00 and Z differ by two hours, a zone-less string is UTC", () => {
    expect(at("2026-08-07T14:00:00+02:00")).toHaveProperty("meta"); // = 12:00Z, at the boundary: kept
    expect(at("2026-08-07T13:59:59+02:00")).toEqual({ dropped: "old" }); // 11:59:59Z
    expect(at("2026-08-07T12:00:00Z")).toHaveProperty("meta");
    expect(at("2026-08-07T11:59:59Z")).toEqual({ dropped: "old" });
    expect(at("2026-08-07T12:00:00")).toHaveProperty("meta"); // UTC, whatever the server's zone
    expect(at("2026-08-07T11:59:59")).toEqual({ dropped: "old" });
  });
  it("anything that is not an ISO time is unusable", () => {
    for (const t of ["yesterday", "11/04/2026", "2026-11-04", "2026-11-04 10:00:00", "2026-13-45T99:00:00Z"]) expect(at(t), t).toEqual({ dropped: "unusable" });
  });
});

describe("item 2: a link's query may carry only one token and our own select and order", () => {
  const ID = "AAMkInbox=";
  const path = `https://graph.microsoft.com/v1.0/me/mailFolders/${ID}/messages/delta`;
  it("accepts exactly one $skiptoken or $deltatoken, with or without our own $select and $orderby byte for byte", () => {
    for (const q of ["$deltatoken=abc", "$skiptoken=abc", `$skiptoken=abc&${SELECT_PARAM}`, `${SELECT_PARAM}&${ORDERBY_PARAM}&$deltatoken=abc`, `$deltatoken=a%3D%3D&${ORDERBY_PARAM}`]) {
      expect(validateDeltaLink(`${path}?${q}`, ID), q).toEqual({ query: q });
    }
    expect(INITIAL_QUERY).toBe(`${SELECT_PARAM}&${ORDERBY_PARAM}`);
  });
  it("refuses another key, a wider $select, a repeated key, two tokens, no token, an empty token or an empty parameter", () => {
    for (const q of ["$deltatoken=a&$select=body", "$deltatoken=a&$select=id,body", `$deltatoken=a&${SELECT_PARAM},body`, "$deltatoken=a&$expand=attachments", "$deltatoken=a&$filter=isRead%20eq%20false", "$deltatoken=a&$search=x", "$deltatoken=a&$deltatoken=b", "$deltatoken=a&$skiptoken=b", "$deltatoken=a&$deltatoken=a", `${SELECT_PARAM}`, `${ORDERBY_PARAM}`, "$deltatoken=", "$deltatoken=a&", "&$deltatoken=a", "$deltatoken=a&$orderby=receivedDateTime%20asc", "$deltatoken=a&$top=1", "token=a", "$DELTATOKEN=a"]) {
      expect(validateDeltaLink(`${path}?${q}`, ID), q).toBeNull();
    }
  });
  it("in a stored cursor ($delta or $next): fullResyncRequired with zero requests and no token read; a link from Graph itself is not stored", async () => {
    const env = setup();
    const base = await env.m.provider.sync("PKG", env.conn, null);
    const good = parseCursor((base.nextCursor as CommsCursor).value, env.conn.id) as CursorState;
    const f0 = good.folders[0] as CursorState["folders"][number];
    const hostile = ["$deltatoken=a&$select=body", "$deltatoken=a&$expand=attachments", "$deltatoken=a&$filter=x", "$deltatoken=a&$search=x", "$deltatoken=a&$deltatoken=b"];
    for (const q of hostile) {
      for (const slot of ["delta", "next"] as const) {
        const link = `https://graph.microsoft.com/v1.0/me/mailFolders/${f0.id}/messages/delta?${q}`;
        const state: CursorState = { ...good, pos: 0, folders: [{ name: f0.name, id: f0.id, since: f0.since, [slot]: link }, ...good.folders.slice(1)] };
        // encodeCursor does not validate links; parseCursor does
        const cursor = encodeCursor(env.conn.id, state) as CommsCursor;
        const before = env.m.externalRequestCount();
        const reads = env.m.h.stats.tokenReads;
        expect(await env.m.provider.sync("PKG", env.conn, cursor), `${q} ${slot}`).toMatchObject({ fullResyncRequired: true });
        expect(env.m.externalRequestCount()).toBe(before);
        expect(env.m.h.stats.tokenReads).toBe(reads);
      }
    }
    const fresh = setup({ mail: { rewriteLink: (l) => `${l}&$select=body` } });
    const e = await failure(fresh.m.provider.sync("PKG", fresh.conn, null));
    expect(e.info.kind).toBe("provider_error");
    expect(e.message).not.toMatch(/body/);
  });
});

describe("item 3: an optional folder the mailbox does not have, and a stored folder id that stops answering", () => {
  const three = ["inbox", "sentitems", "archive"] as ("inbox" | "sentitems" | "archive")[];
  it("a 404 on the archive lookup leaves it out; inbox and sent sync; it is recorded absent in the cursor and a count is logged (no mailbox data)", async () => {
    const env = setup({ folders: three });
    env.mail.hideFolder(env.account, "archive");
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.written).toBe(5);
    const s = stateOf(env);
    expect(s.folders.map((f) => f.name)).toEqual(["inbox", "sentitems"]);
    expect(s.absent).toEqual(["archive"]);
    const entry = env.m.h.logs.find((l) => l.event === "microsoft.mail.folders_absent");
    expect(entry?.fields).toEqual({ count: 1, configured: 3 });
  });
  it("it is looked for again at the start of a cycle, at most once an hour, and loaded in full when it appears", async () => {
    let t = Date.parse("2026-11-05T12:00:00Z");
    const env = setup({ folders: three, harness: { providerNow: () => t } });
    env.mail.hideFolder(env.account, "archive");
    await env.m.sync.run("PKG", env.conn);
    const lookups = () => env.mail.requests.filter((r) => r.kind === "folder").length;
    const before = lookups();
    await env.m.sync.run("PKG", env.conn); // within the hour: no lookup at all
    expect(lookups()).toBe(before);
    env.mail.showFolder(env.account, "archive");
    env.mail.add(env.account, "archive", { ageDays: 2 });
    t += 30 * 60_000;
    await env.m.sync.run("PKG", env.conn); // 30 minutes: still not looked for
    expect(lookups()).toBe(before);
    t += 31 * 60_000;
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.written).toBe(1);
    expect(lookups()).toBe(before + 3); // one discovery: every configured folder is resolved once
    const s = stateOf(env);
    expect(s.folders.map((f) => f.name)).toEqual(["inbox", "sentitems", "archive"]);
    expect(s.absent).toBeUndefined();
    expect(env.m.twin.rowsOf(env.conn.id).filter((r) => r.folder === "ARCHIVE")).toHaveLength(1);
  });
  it("a 404 on the lookup of inbox or sentitems stays a hard failure", async () => {
    for (const hidden of ["inbox", "sentitems"] as const) {
      const env = setup({ folders: three });
      env.mail.hideFolder(env.account, hidden);
      expect((await failure(env.m.provider.sync("PKG", env.conn, null))).info.http_status).toBe(404);
    }
  });
  it("a stored folder id that later answers 404 is not a failure forever: the cursor needs a fresh discovery (resync) and the new id is used", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    const oldId = stateOf(env).folders[0]?.id;
    const newId = env.mail.recreateFolder(env.account, "inbox");
    expect(newId).not.toBe(oldId);
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run).toMatchObject({ resynced: true, mode: "full" });
    expect(stateOf(env).folders[0]?.id).toBe(newId);
  });
  it("a folder id resolved in the same call that answers 404 is a failure (no resync loop)", async () => {
    const env = setup();
    server.use(http.get("https://graph.microsoft.com/v1.0/me/mailFolders/:id/messages/delta", () => HttpResponse.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 })));
    expect((await failure(env.m.provider.sync("PKG", env.conn, null))).info.http_status).toBe(404);
  });
});

describe("item 7: cases the code review found missing", () => {
  it("an empty folder: a page with no items and a delta link ends the folder and the cursor advances", async () => {
    const env = setup({ folders: ["inbox", "sentitems", "archive"] });
    const run = await env.m.sync.run("PKG", env.conn);
    expect(run.written).toBe(5);
    const s = stateOf(env);
    expect(s.folders.find((f) => f.name === "archive")?.delta).toBeDefined(); // the archive has no messages
    expect(s.pos).toBe(0);
  });
  it("replaying the same page with the same cursor gives the same end state", async () => {
    const env = setup();
    const first = await env.m.provider.sync("PKG", env.conn, null);
    const a = await env.m.provider.sync("PKG", env.conn, first.nextCursor);
    const b = await env.m.provider.sync("PKG", env.conn, first.nextCursor);
    expect(b.nextCursor).toEqual(a.nextCursor);
    expect(b.upserts).toEqual(a.upserts);
    expect(b.removals).toEqual(a.removals);
    // applying the same page twice leaves the same rows
    const env2 = setup();
    await env2.m.sync.run("PKG", env2.conn);
    const rows = JSON.stringify([...env2.m.twin.rows.values()]);
    const page = await env2.m.provider.sync("PKG", env2.conn, { value: env2.m.twin.cursorOf("PKG", env2.conn.id) as string });
    expect(page.upserts).toEqual([]);
    expect(JSON.stringify([...env2.m.twin.rows.values()])).toBe(rows);
  });
  it("a change of the configured folder ORDER only: no re-discovery (no lookups), the cursor's order is kept", async () => {
    const env = setup();
    await env.m.sync.run("PKG", env.conn);
    const lookups = env.mail.requests.filter((r) => r.kind === "folder").length;
    env.m.h.setLane("PKG", { microsoft: { tenantIds: [TENANT_A], mailFolders: ["sentitems", "inbox"] } });
    await env.m.sync.run("PKG", env.conn);
    expect(env.mail.requests.filter((r) => r.kind === "folder").length).toBe(lookups);
    expect(stateOf(env).folders.map((f) => f.name)).toEqual(["inbox", "sentitems"]);
  });
});
