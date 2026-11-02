import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  BODY_EXACT_NAMES, BODY_SAFE_TOKENS, BODY_SUBSTRINGS, CONTENT_PROVIDERS, FORBIDDEN_NAMES, assertContentAllowed,
  assertNoForbiddenFields, hasBodyField, hasForbiddenField, isContentProvider, normalizeKey,
} from "./guard";

const kind = (fn: () => void) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as { info?: { kind: string } }).info?.kind;
  }
};

describe("hasBodyField", () => {
  it.each([
    [{ id: "m1", body: { content: "synthetic" } }],
    [{ id: "m1", bodyPreview: "x" }],
    [{ id: "m1", body_preview: "x" }],
    [{ id: "m1", "Body-Preview": "x" }],
    [{ items: [{ parts: [{ snippet: "x" }] }] }],
    [{ a: { b: { HTML: "<p>x</p>" } } }],
    [{ description: "x" }], [{ notes: "x" }], [{ contentBytes: "x" }], [{ formattedText: "x" }],
    [{ argumentText: "x" }], [{ indexableText: "x" }], [{ values: [1] }], [{ messageBody: "x" }],
    [{ bodyText: "x" }], [{ bodyContent: "x" }], [{ fullText: "x" }], [{ emailBody: "x" }],
    [{ comment: "x" }], [{ attachmentData: "x" }], [{ dataUrl: "x" }], [{ narrative: "x" }],
    [{ "ｂｏｄｙ": "x" }], [{ "bódy": "x" }], [{ contentTypeBody: "x" }], [{ raw: "x" }],
  ])("finds a body key in %j", (payload) => expect(hasBodyField(payload)).toBe(true));

  it.each([
    [{ contentType: "text/plain", contentLength: 10, textColor: "red", messageId: "m", internetMessageId: "<x>" }],
    [{ context_id: "c", hasAttachments: true, attachmentCount: 2, commentCount: 1 }],
  ])("keeps the documented safe metadata keys storable: %j", (payload) => expect(hasBodyField(payload)).toBe(false));

  it("passes metadata-only payloads and does not scan values", () => {
    expect(hasBodyField({ id: "m1", subject: "Hello", from: "a@example.test", labels: ["INBOX"], note: "the body is here" })).toBe(false);
  });

  it("fails closed on very deep nesting", () => {
    let deep: unknown = { x: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(hasBodyField(deep)).toBe(true);
  });
});

describe("assertContentAllowed", () => {
  const mail = { provider: "google", payload: { id: "m1", body: { content: "synthetic" } } };
  const meta = { provider: "google", payload: { id: "m2", subject: "Hi" } };
  const finance = { provider: "quickbooks", payload: { Id: "1", text: "memo" } };

  it("rejects a comms/docs record with a body when the lane does not store bodies", () => {
    for (const provider of ["google", "microsoft", "notion", "monday", "gohighlevel", "timesolv"]) {
      expect(kind(() => assertContentAllowed([{ ...mail, provider }], { storeContentBodies: false }))).toBe("forbidden");
    }
  });
  it("rejects the whole batch when one record has a body", () => {
    expect(kind(() => assertContentAllowed([meta, mail], { storeContentBodies: false }))).toBe("forbidden");
  });
  it("allows the same record when the lane policy allows bodies", () => {
    expect(kind(() => assertContentAllowed([mail], { storeContentBodies: true }))).toBe("ok");
  });
  it("allows metadata-only comms records and any finance record", () => {
    expect(kind(() => assertContentAllowed([meta, finance], { storeContentBodies: false }))).toBe("ok");
  });
  it("treats anything other than true as not allowed", () => {
    expect(kind(() => assertContentAllowed([mail], { storeContentBodies: undefined as unknown as boolean }))).toBe("forbidden");
  });
  it("never echoes the record in the error", () => {
    expect.assertions(2);
    try {
      assertContentAllowed([mail], { storeContentBodies: false });
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/synthetic|body|m1/);
    }
    expect(() => assertContentAllowed([mail], { storeContentBodies: false })).toThrow();
  });
});

describe("hasForbiddenField", () => {
  it.each(FORBIDDEN_NAMES.map((n) => [n]))("rejects %s at any depth, any case and punctuation", (name) => {
    expect(hasForbiddenField({ a: [{ [name.toUpperCase()]: "x" }] })).toBe(true);
    expect(hasForbiddenField({ ["x_" + name]: "x" })).toBe(false);
  });
  it("catches common spellings", () => {
    for (const k of ["SSN", "tax_id", "AcctNum", "account-number", "routingNumber", "bill_rate", "clientSecret", "access_token"]) {
      expect(hasForbiddenField({ [k]: "x" })).toBe(true);
    }
  });
  it("fails closed when too deep and passes ordinary payloads", () => {
    let deep: unknown = { x: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(hasForbiddenField(deep)).toBe(true);
    expect(hasForbiddenField({ Id: "1", TotalAmt: "10.00", pinned: true })).toBe(false);
  });
  it("assertNoForbiddenFields throws invalid_input without echoing", () => {
    expect(kind(() => assertNoForbiddenFields([{ payload: { ssn: "000-00-0000" } }]))).toBe("invalid_input");
    expect(() => assertNoForbiddenFields([{ payload: { ssn: "000-00-0000" } }])).toThrow(/^(?!.*(ssn|000)).*$/i);
  });
});

describe("lists match the database", () => {
  const dir = new URL("../../../../supabase/core/supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).filter((f) => f.endsWith("_raw_source_records.sql"));
  const sql = readFileSync(new URL(file[0] as string, dir), "utf8");
  const quoted = (s: string) => [...s.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1] as string);
  const arrayOf = (fn: string) => quoted(new RegExp(`function raw\\.${fn}\\(\\)[\\s\\S]*?array\\[([^\\]]*)\\]`).exec(sql)?.[1] ?? "");

  it("finds exactly one migration", () => expect(file).toHaveLength(1));
  it("content providers", () => {
    const fn = /raw\.is_content_provider[\s\S]*?\$\$ select p_provider in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect(quoted(fn).sort()).toEqual([...CONTENT_PROVIDERS].sort());
    expect(CONTENT_PROVIDERS.every(isContentProvider)).toBe(true);
  });
  it("body exact names, substrings, safe tokens (order matters for safe tokens) and forbidden names", () => {
    expect(arrayOf("body_exact_names")).toEqual([...BODY_EXACT_NAMES]);
    expect(arrayOf("body_substrings")).toEqual([...BODY_SUBSTRINGS]);
    expect(arrayOf("body_safe_tokens")).toEqual([...BODY_SAFE_TOKENS]);
    expect(arrayOf("forbidden_names")).toEqual([...FORBIDDEN_NAMES]);
  });
  it("normalises like the database", () => {
    expect(normalizeKey("Body-Préview_1")).toBe("bodypreview1");
  });
});
