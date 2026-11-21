// The composite cursor of the Microsoft mail sync (T-258): the encoding, the 16 KB bound, binding to the connection, and the link rules
// (origin and path validated against the folder id held in the cursor; nothing else is ever followed).
import { describe, expect, it } from "vitest";
import { microsoftSchema } from "@nichols/core/lane-config";
import { CommsCursorSchema } from "../comms/schemas";
import { cursorPrefix, encodeCursor, fingerprintOf, MAX_CURSOR_CHARS, MAX_FOLDER_ID_CHARS, MAX_LINK_CHARS, parseCursor, validateDeltaLink, type CursorState, type FolderState } from "./mail-cursor";

const CONN = "00000000-0000-4000-8000-000000025801";
const OTHER_CONN = "00000000-0000-4000-8000-000000025802";
const ORIGIN = "https://graph.microsoft.com/v1.0";
const SINCE = "2026-08-07T12:00:00.000Z";
const deltaPath = (id: string) => `${ORIGIN}/me/mailFolders/${id}/messages/delta`;
/** A link of exactly `length` characters for the folder: the path plus `?$deltatoken=` plus filler in the token character set. */
const linkOf = (id: string, length: number, style: "slash" | "paren" = "slash") => {
  const head = style === "slash" ? deltaPath(id) : `${ORIGIN}/me/mailFolders('${id}')/messages/delta`;
  const prefix = `${head}?$deltatoken=`;
  return prefix + "A".repeat(length - prefix.length);
};
const state = (folders: FolderState[], pos = 0): CursorState => ({ v: 1, folders, pos, fp: fingerprintOf(folders.map((f) => f.name)) });
const folder = (name: FolderState["name"], id: string, over: Partial<FolderState> = {}): FolderState => ({ name, id, since: SINCE, ...over });

describe("encoding and parsing", () => {
  it("round-trips a state under the prefix m1.<connection id>.m:", () => {
    const s = state([folder("inbox", "AAMkInbox=", { delta: `${deltaPath("AAMkInbox=")}?$deltatoken=abc%3D` }), folder("sentitems", "AAMkSent=")], 1);
    const c = encodeCursor(CONN, s);
    expect(c?.value.startsWith(cursorPrefix(CONN))).toBe(true);
    expect(c?.value.startsWith(`m1.${CONN}.m:`)).toBe(true);
    expect(parseCursor(c?.value ?? "", CONN)).toEqual(s);
  });

  it("carries no credential-looking text: only folder ids, Graph's own opaque links, a time, a position and the fingerprint", () => {
    const c = encodeCursor(CONN, state([folder("inbox", "AAMkInbox=")]));
    const json = Buffer.from((c?.value ?? "").slice(cursorPrefix(CONN).length), "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual(["folders", "fp", "pos", "v"]);
    expect(json).not.toMatch(/bearer|access_token|refresh_token|authorization/i);
  });

  it("the largest allowed state (3 folders, the longest ids and links) stays under 16 KB and still parses", () => {
    const id = (n: string) => `${n}${"x".repeat(MAX_FOLDER_ID_CHARS - n.length)}`;
    const ids = [id("I"), id("S"), id("A")];
    for (const style of ["slash", "paren"] as const) {
      const folders = [
        folder("inbox", ids[0] as string, { delta: linkOf(ids[0] as string, MAX_LINK_CHARS, style) }),
        folder("sentitems", ids[1] as string, { next: linkOf(ids[1] as string, MAX_LINK_CHARS, style) }),
        folder("archive", ids[2] as string, { delta: linkOf(ids[2] as string, MAX_LINK_CHARS, style) }),
      ];
      const c = encodeCursor(CONN, state(folders, 2));
      expect(c, style).not.toBeNull();
      expect((c?.value ?? "").length, style).toBeLessThan(16 * 1024);
      expect((c?.value ?? "").length).toBeLessThan(MAX_CURSOR_CHARS);
      expect(CommsCursorSchema.safeParse(c).success).toBe(true);
      expect(parseCursor(c?.value ?? "", CONN)?.folders.map((f) => f.id)).toEqual(ids);
    }
  });

  it("a state that would not fit is refused (null), never truncated; so is a link above our bound", () => {
    // Built by hand, past the link bound, to show the 16 KB check on its own: three 6,000-character links encode to more than the table allows.
    const ids = ["IdOne", "IdTwo", "IdThree"];
    const big = state(ids.map((id, i) => folder((["inbox", "sentitems", "archive"] as const)[i] as FolderState["name"], id, { delta: linkOf(id, 6000) })));
    expect(encodeCursor(CONN, big)).toBeNull();
    // A link of MAX_LINK_CHARS + 1 does not parse even when the whole cursor would fit.
    const one = state([folder("inbox", "AAMkInbox=", { delta: linkOf("AAMkInbox=", MAX_LINK_CHARS + 1) })]);
    const c = encodeCursor(CONN, one);
    expect(c === null || parseCursor(c.value, CONN) === null).toBe(true);
  });

  it("a 4th folder is refused: by the lane config, and a cursor holding four is malformed", () => {
    expect(microsoftSchema.safeParse({ tenant_ids: ["11111111-1111-4111-8111-111111111111"], mail_folders: ["inbox", "sentitems", "archive", "inbox"] }).success).toBe(false);
    const four = { v: 1, folders: ["inbox", "sentitems", "archive", "inbox"].map((name, i) => ({ name, id: `Id${String(i)}`, since: SINCE })), pos: 0, fp: "x" };
    expect(parseCursor(`${cursorPrefix(CONN)}${Buffer.from(JSON.stringify(four)).toString("base64url")}`, CONN)).toBeNull();
  });

  it("is bound to its connection: another connection's cursor, a Google cursor and a calendar cursor are malformed", () => {
    const c = encodeCursor(CONN, state([folder("inbox", "AAMkInbox=")]))?.value ?? "";
    expect(parseCursor(c, OTHER_CONN)).toBeNull();
    expect(parseCursor(c.replace("m1.", "g1."), CONN)).toBeNull();
    expect(parseCursor(c.replace(".m:", ".c:"), CONN)).toBeNull();
    expect(parseCursor(c.replace(".m:", "."), CONN)).toBeNull();
    expect(parseCursor(c.toUpperCase(), CONN)).toBeNull();
  });

  it("garbage is malformed, never a throw: not base64url, not JSON, wrong shape, extra keys, bad position, two links, duplicate folders, bad time", () => {
    const enc = (v: unknown) => `${cursorPrefix(CONN)}${Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url")}`;
    const ok = { v: 1, folders: [{ name: "inbox", id: "AAMkInbox=", since: SINCE }], pos: 0, fp: "inbox" };
    expect(parseCursor(enc(ok), CONN)).not.toBeNull();
    const link = `${deltaPath("AAMkInbox=")}?$deltatoken=x`;
    const bad: unknown[] = [
      "not json",
      "[]",
      { ...ok, v: 2 },
      { ...ok, extra: 1 },
      { ...ok, pos: 1 },
      { ...ok, pos: -1 },
      { ...ok, folders: [] },
      { ...ok, folders: [{ ...ok.folders[0], delta: link, next: link }] },
      { ...ok, folders: [ok.folders[0], ok.folders[0]] },
      { ...ok, folders: [{ ...ok.folders[0], since: "yesterday" }] },
      { ...ok, folders: [{ ...ok.folders[0], name: "drafts" }] },
      { ...ok, folders: [{ ...ok.folders[0], id: "has/slash" }] },
      { ...ok, folders: [{ ...ok.folders[0], id: "x".repeat(MAX_FOLDER_ID_CHARS + 1) }] },
      { ...ok, folders: [{ ...ok.folders[0], extra: "x" }] },
    ];
    for (const b of bad) expect(parseCursor(enc(b), CONN), JSON.stringify(b)).toBeNull();
    for (const raw of ["", cursorPrefix(CONN), `${cursorPrefix(CONN)}***`, `${cursorPrefix(CONN)}${"A".repeat(20_000)}`, `x${enc(ok)}`]) expect(parseCursor(raw, CONN)).toBeNull();
  });

  it("the fingerprint ignores order and duplicates", () => {
    expect(fingerprintOf(["sentitems", "inbox"])).toBe(fingerprintOf(["inbox", "sentitems"]));
    expect(fingerprintOf(["inbox"])).not.toBe(fingerprintOf(["inbox", "archive"]));
  });
});

describe("link validation: origin and path are checked against the folder id of the cursor", () => {
  const ID = "AAMkInbox=";
  const good = `${deltaPath(ID)}?$deltatoken=abc%3D%3D`;

  it("accepts the slash form and the OData key form, with the id raw or percent-encoded, and returns the query exactly as stored", () => {
    expect(validateDeltaLink(good, ID)).toEqual({ query: "$deltatoken=abc%3D%3D" });
    expect(validateDeltaLink(`${deltaPath(encodeURIComponent(ID))}?$skiptoken=s1_-.~`, ID)).toEqual({ query: "$skiptoken=s1_-.~" });
    expect(validateDeltaLink(`${ORIGIN}/me/mailFolders('${ID}')/messages/delta?$deltatoken=q`, ID)).toEqual({ query: "$deltatoken=q" });
    expect(validateDeltaLink(`${ORIGIN}/me/mailFolders(%27${encodeURIComponent(ID)}%27)/messages/delta?$deltatoken=q`, ID)).toEqual({ query: "$deltatoken=q" });
  });

  it("refuses another host, scheme, port, user info or look-alike host", () => {
    const tail = `/v1.0/me/mailFolders/${ID}/messages/delta?$deltatoken=x`;
    for (const origin of ["https://evil.example.test", "http://graph.microsoft.com", "https://graph.microsoft.com:8443", "https://graph.microsoft.com@evil.example.test", "https://user:pw@graph.microsoft.com", "https://graph.microsoft.com.evil.example.test", "https://GRAPH.microsoft.com", "https://graph.microsoft.us", "//graph.microsoft.com", "graph.microsoft.com"]) {
      expect(validateDeltaLink(`${origin}${tail}`, ID), origin).toBeNull();
    }
  });

  it("refuses another path: another endpoint, another user, another version, extra or missing segments, dot segments, encoded separators", () => {
    const q = "?$deltatoken=x";
    const paths = [
      "/v1.0/me/messages/delta",
      "/v1.0/me/mailFolders/AAMkInbox=/messages",
      "/v1.0/me/mailFolders/AAMkInbox=/messages/delta/extra",
      "/v1.0/me/mailFolders/AAMkInbox=/childFolders/delta",
      "/v1.0/users/someone@example.test/mailFolders/AAMkInbox=/messages/delta",
      "/v1.0/users('someone')/mailFolders/AAMkInbox=/messages/delta",
      "/beta/me/mailFolders/AAMkInbox=/messages/delta",
      "/me/mailFolders/AAMkInbox=/messages/delta",
      "/v1.0/me/mailFolders/AAMkInbox=/../AAMkOther=/messages/delta",
      "/v1.0/me/mailFolders/AAMkInbox=/./messages/delta",
      "/v1.0//me/mailFolders/AAMkInbox=/messages/delta",
      "/v1.0/me/mailFolders/AAMkInbox=%2Fmessages%2Fdelta",
      "/v1.0/me/mailFolders/AAMkInbox%2F..%2FAAMkOther=/messages/delta",
      "/v1.0/me/MailFolders/AAMkInbox=/messages/delta",
      "/v1.0/me/mailFolders/inbox/messages/delta",
      "/v1.0/me/mailFolders('inbox')/messages/delta",
    ];
    for (const p of paths) expect(validateDeltaLink(`https://graph.microsoft.com${p}${q}`, ID), p).toBeNull();
  });

  it("refuses a link that names another folder than the one the cursor holds it for", () => {
    const other = `${deltaPath("AAMkSent=")}?$deltatoken=x`;
    expect(validateDeltaLink(other, "AAMkSent=")).not.toBeNull();
    expect(validateDeltaLink(other, ID)).toBeNull();
    expect(validateDeltaLink(`${ORIGIN}/me/mailFolders('AAMkSent=')/messages/delta?$deltatoken=x`, ID)).toBeNull();
    // a prefix or suffix of the id is not the id
    expect(validateDeltaLink(`${deltaPath("AAMkInbox==")}?$deltatoken=x`, ID)).toBeNull();
    expect(validateDeltaLink(`${deltaPath("AAMkInbox")}?$deltatoken=x`, ID)).toBeNull();
  });

  it("refuses a fragment, whitespace, control characters, a missing or odd query, and anything over the length bound (never truncated)", () => {
    for (const l of [`${good}#frag`, `${good} x`, `${good}\n`, `${good}\u0000`, deltaPath(ID), `${deltaPath(ID)}?`, `${good}'`, `${good}"`, `${good}<`, `${good}\\`, `${good}é`, ""]) {
      expect(validateDeltaLink(l, ID), JSON.stringify(l)).toBeNull();
    }
    expect(validateDeltaLink(linkOf(ID, MAX_LINK_CHARS), ID)).not.toBeNull();
    expect(validateDeltaLink(linkOf(ID, MAX_LINK_CHARS + 1), ID)).toBeNull();
    for (const notString of [null, undefined, 5, {}, ["x"]]) expect(validateDeltaLink(notString, ID)).toBeNull();
  });

  it("a stored cursor holding an invalid link is malformed as a whole (the cursor is refused, no link is followed)", () => {
    const enc = (link: string) => `${cursorPrefix(CONN)}${Buffer.from(JSON.stringify({ v: 1, folders: [{ name: "inbox", id: ID, since: SINCE, delta: link }], pos: 0, fp: "inbox" })).toString("base64url")}`;
    expect(parseCursor(enc(good), CONN)).not.toBeNull();
    expect(parseCursor(enc(good.replace("graph.microsoft.com", "evil.example.test")), CONN)).toBeNull();
    expect(parseCursor(enc(`${deltaPath("AAMkOther=")}?$deltatoken=x`), CONN)).toBeNull();
  });
});
