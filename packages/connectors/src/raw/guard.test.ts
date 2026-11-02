import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BODY_FIELD_NAMES, CONTENT_PROVIDERS, assertContentAllowed, hasBodyField, isContentProvider } from "./guard";

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
  ])("finds a body key in %j", (payload) => expect(hasBodyField(payload)).toBe(true));

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
    for (const provider of ["google", "microsoft", "notion"]) {
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
    try {
      assertContentAllowed([mail], { storeContentBodies: false });
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/synthetic|body|m1/);
    }
  });
});

describe("lists match the database", () => {
  const sql = readFileSync(new URL("../../../../supabase/core/supabase/migrations/20261102080000_raw_source_records.sql", import.meta.url), "utf8");
  const quoted = (s: string) => [...s.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);

  it("content providers", () => {
    const fn = /raw\.is_content_provider[\s\S]*?\$\$ select p_provider in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect(quoted(fn).sort()).toEqual([...CONTENT_PROVIDERS].sort());
    expect(CONTENT_PROVIDERS.every(isContentProvider)).toBe(true);
  });
  it("body field names", () => {
    const fn = /lower\(pg_catalog\.regexp_replace[\s\S]*?in \(([^)]*)\)/.exec(sql.replace(/pg_catalog\.lower/, "lower"))?.[1] ?? "";
    expect(quoted(fn).sort()).toEqual([...BODY_FIELD_NAMES].sort());
  });
});
