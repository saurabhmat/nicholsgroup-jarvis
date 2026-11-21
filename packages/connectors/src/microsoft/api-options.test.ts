// The T-258 extension of the Graph client: an optional `Prefer` header and an opaque raw query, for a delta link's query and the first delta request. Every
// T-256 guarantee still holds on that path (host allow-list, /me only, the guard before every attempt, the mailbox slots, no token before the guard); the
// T-256 tests themselves (api.test.ts) are unchanged and run beside this file.
import { afterEach, describe, expect, it } from "vitest";
import { isConnectorError } from "../contract/errors";
import { PROVIDER_DISABLED_MESSAGE } from "../facade/gate";
import { RateLimiter } from "../http/rate-limit";
import { createMicrosoftHarness, TENANT_A } from "../testing/microsoft-harness";
import { useMockServer } from "../testing/msw/index";
import { createFakeMicrosoft } from "../testing/msw/microsoft/handlers";
import { createFakeMail } from "../testing/msw/microsoft/mail";
import { MAX_RAW_QUERY, isOpaqueQuery, createGraphApi } from "./api";
import { resetMailboxSlotsForTests } from "./concurrency";

const server = useMockServer();
afterEach(() => {
  RateLimiter.resetForTests();
  resetMailboxSlotsForTests();
});
const EXEC = "exec@pubkgroup.example.test";
const PREFER = { Prefer: 'IdType="ImmutableId"' };
const DELTA = "/me/mailFolders/{id}/messages/delta";

function setup(over: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = createFakeMicrosoft();
  const mail = createFakeMail(fake);
  server.use(...fake.handlers, ...mail.handlers);
  const h = createMicrosoftHarness({ fake, lanes: { PKG: { providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A] }, domains: ["pubkgroup.example.test"] } }, ...over });
  const made = h.connect("PKG", EXEC);
  const folderId = mail.folderId(made.account, "inbox");
  return { fake, mail, h, folderId, ...made };
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

describe("headers and a raw query", () => {
  it("the Prefer header and the raw query go out exactly as given, with the bearer token", async () => {
    const { h, mail, conn, folderId } = setup();
    const raw = "$select=id,subject&$orderby=receivedDateTime%20desc";
    const res = await h.api.get("PKG", conn, DELTA, { id: folderId }, undefined, { headers: { Prefer: 'IdType="ImmutableId", odata.maxpagesize=7' }, rawQuery: raw });
    expect(res.status).toBe(200);
    const sent = mail.deltaRequests()[0];
    expect(sent?.search).toBe(`?${raw}`);
    expect(sent?.prefer).toBe('IdType="ImmutableId", odata.maxpagesize=7');
    expect(sent?.path).toBe(`/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`);
    expect(h.stats.tokenReads).toBe(1);
  });

  it("an opaque token with percent escapes, plus, equals and slashes is sent byte for byte", async () => {
    const { h, mail, conn, folderId } = setup();
    const raw = "$deltatoken=dt-1-Zm9v%3D%3D_x-y.z~+/a=b";
    await h.api.get("PKG", conn, DELTA, { id: folderId }, undefined, { headers: PREFER, rawQuery: raw }).catch(() => undefined);
    expect(mail.deltaRequests()[0]?.search.startsWith(`?${raw}`)).toBe(true);
  });

  it("no other header is allowed (only Prefer), and a Prefer value must be printable ASCII within 200 characters: refused before any token read or request", async () => {
    const { h, fake, mail, conn, folderId } = setup();
    const bad: Record<string, string>[] = [{ Authorization: "Bearer x" }, { Host: "evil.example.test" }, { "X-Anything": "1" }, { Prefer: "a\r\nX: y" }, { Prefer: "x".repeat(201) }, { Prefer: "" }, { Prefer: "café" }, { PREFER: "ok", Cookie: "a=b" }];
    for (const headers of bad) {
      expect((await failure(h.api.get("PKG", conn, DELTA, { id: folderId }, undefined, { headers }))).info.kind, JSON.stringify(headers)).toBe("invalid_input");
    }
    expect(h.stats.tokenReads).toBe(0);
    expect(fake.state.graphRequests).toHaveLength(0);
    expect(mail.requests).toHaveLength(0);
  });

  it("a raw query outside the URL character set, longer than the bound, or combined with a query object is refused before any token read or request", async () => {
    const { h, mail, conn, folderId } = setup();
    for (const rawQuery of ["a=b#frag", "a b", "a=b'", 'a="x"', "a=b\r\nHost: evil", "a=é", "a=<b>", "a=\\b", "x".repeat(MAX_RAW_QUERY + 1)]) {
      expect((await failure(h.api.get("PKG", conn, DELTA, { id: folderId }, undefined, { rawQuery }))).info.kind, rawQuery.slice(0, 20)).toBe("invalid_input");
    }
    expect((await failure(h.api.get("PKG", conn, DELTA, { id: folderId }, { a: "1" }, { rawQuery: "b=2" }))).info.kind).toBe("invalid_input");
    expect(h.stats.tokenReads).toBe(0);
    expect(mail.requests).toHaveLength(0);
    expect(isOpaqueQuery("$deltatoken=a%3D")).toBe(true);
    expect(isOpaqueQuery("x".repeat(MAX_RAW_QUERY))).toBe(true);
    expect(isOpaqueQuery("a#b")).toBe(false);
  });

  it("a raw query cannot move the request: other paths, another user's mailbox, path parameters with separators or escapes are still refused", async () => {
    const { h, fake, mail, conn, folderId } = setup();
    for (const [path, params] of [["/users/{id}/messages", { id: "x" }], ["/me/../users/x", undefined], ["/me?$select=id", undefined], [DELTA, { id: "a/b" }], [DELTA, { id: "a%2Fb" }], [DELTA, { id: "a\\b" }]] as const) {
      expect((await failure(h.api.get("PKG", conn, path, params ? { ...params } : undefined, undefined, { headers: PREFER, rawQuery: "$deltatoken=x" }))).info.kind, path).toBe("invalid_input");
    }
    // the query cannot carry a path, a host or a second request: '/' and '?' are legal in a query, but the request line is still the template's
    await h.api.get("PKG", conn, DELTA, { id: folderId }, undefined, { headers: PREFER, rawQuery: "$select=id&redirect=https://evil.example.test/x?y" });
    expect(mail.deltaRequests()).toHaveLength(1);
    expect(mail.deltaRequests()[0]?.path).toBe(`/v1.0/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`);
    expect(fake.state.tokenRequests).toHaveLength(0);
  });

  it("the host allow-list still holds: a test hook cannot replace the base URL, and the raw query goes only to graph.microsoft.com", async () => {
    const { h, conn, folderId, fake, mail } = setup();
    const api = createGraphApi({ guard: h.guard, tokens: h.tokens, httpOptions: { baseUrl: "https://evil.example.test/v1.0" } as never });
    await api.get("PKG", conn, DELTA, { id: folderId }, undefined, { headers: PREFER, rawQuery: "$select=id" });
    expect(mail.deltaRequests()).toHaveLength(1); // it went to the fake Graph host (an evil host has no handler: the test would have failed)
    expect(fake.state.tokenRequests).toHaveLength(0);
  });

  it("the guard still decides before the token is read: a disabled provider or a removed tenant is refused with the raw query and the header, no token read, no request", async () => {
    const { h, mail, conn, folderId } = setup();
    h.setLane("PKG", { providers: ["google"] });
    const e = await failure(h.api.get("PKG", conn, DELTA, { id: folderId }, undefined, { headers: PREFER, rawQuery: "$select=id" }));
    expect(e.info).toMatchObject({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    expect(h.stats.tokenReads).toBe(0);
    expect(mail.requests).toHaveLength(0);
  });

  it("the guard runs again before a retry: with an unchanged config the retry goes out (one more settings read); a provider disabled during the Retry-After sleep is never sent the retry", async () => {
    const a = setup();
    a.account.throttle = { status: 503, retryAfter: 1, remaining: 1 };
    await a.h.api.get("PKG", a.conn, DELTA, { id: a.folderId }, undefined, { headers: PREFER, rawQuery: "$select=id" });
    expect(a.mail.deltaRequests()).toHaveLength(2);
    expect(a.mail.deltaRequests()[1]?.search).toBe("?$select=id");
    expect(a.h.stats.settingsReads).toBe(2);

    const b = setup({ sleep: async (ms) => { if (ms === 7000) b.h.setLane("PKG", { providers: ["google"] }); } });
    b.account.throttle = { status: 503, retryAfter: 7, remaining: 5 };
    const e = await failure(b.h.api.get("PKG", b.conn, DELTA, { id: b.folderId }, undefined, { headers: PREFER, rawQuery: "$select=id" }));
    expect(e.info).toMatchObject({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
    expect(b.mail.deltaRequests()).toHaveLength(1);
    expect(b.h.stats.tokenReads).toBe(1);
  });

  it("without the new options nothing changes: no header is added and the query object is encoded as before", async () => {
    const { h, fake, conn } = setup();
    await h.api.get("PKG", conn, "/me", undefined, { $select: "mail" });
    expect(fake.state.graphRequests[0]?.search).toBe("?%24select=mail");
  });
});
