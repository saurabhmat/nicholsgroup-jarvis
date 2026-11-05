import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  BODY_EXACT_NAMES, BODY_SAFE_TOKENS, BODY_SUBSTRINGS, CONTENT_PROVIDERS, FORBIDDEN_CONTAINED, FORBIDDEN_WORDS, FORBIDDEN_WORD_ENDS,
  MAX_DISTINCT_KEYS, RATE_NEIGHBOURS, TOKEN_SAFE_NAMES, assertContentAllowed, assertNoForbiddenFields, hasBodyField,
  hasForbiddenField, hasNul, isContentProvider, keyTooLong, keyWords, normalizeKey, payloadProblem, stripForbidden,
} from "./guard";

/** keyWords fixtures, repeated in supabase/core/supabase/tests/110_raw_source_records.test.sql (raw.key_words). */
const KEY_WORD_CASES: [string, string[]][] = [
  ["employeeSsn", ["employee", "ssn"]],
  ["SSNLast4", ["ssn", "last", "4"]],
  ["ssn_last4", ["ssn", "last", "4"]],
  ["Body-Preview", ["body", "preview"]],
  ["hourlyRate", ["hourly", "rate"]],
  ["classname", ["classname"]],
  ["id_token", ["id", "token"]],
  ["PrimaryTaxIdentifier", ["primary", "tax", "identifier"]],
  ["bódy.text", ["body", "text"]],
  ["SSNs", ["ssns"]],
  ["PINs", ["pins"]],
  ["IBANs", ["ibans"]],
  ["PINsList", ["pins", "list"]],
  ["SSNStatus", ["ssn", "status"]],
  ["XMLHttpRequest", ["xml", "http", "request"]],
  ["", []],
];

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
    [{ note: "x" }], [{ memo: "x" }], [{ transcript: "x" }], [{ preview: "x" }], [{ excerpt: "x" }], [{ caption: "x" }],
    [{ internalNote: "x" }], [{ MeetingTranscript: "x" }],
  ])("finds a body key in %j", (payload) => expect(hasBodyField(payload)).toBe(true));

  it.each([
    [{ contentType: "text/plain", contentLength: 10, textColor: "red", messageId: "m", internetMessageId: "<x>" }],
    [{ context_id: "c", hasAttachments: true, attachmentCount: 2, commentCount: 1 }],
    [{ htmlLink: "https://example.test/x", webContentLink: "https://example.test/y" }],
    [{ messagesTotal: 10, messagesUnread: 2, lastMessageType: "email", lastMessageDate: "2026-11-01T00:00:00Z" }],
  ])("keeps the documented safe metadata keys storable: %j", (payload) => expect(hasBodyField(payload)).toBe(false));

  it("passes metadata-only payloads and does not scan values", () => {
    expect(hasBodyField({ id: "m1", subject: "Hello", from: "a@example.test", labels: ["INBOX"], subject2: "the body is here" })).toBe(false);
  });

  it("fails closed on very deep nesting", () => {
    let deep: unknown = { x: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(hasBodyField(deep)).toBe(true);
  });
});

describe("safe tokens", () => {
  it("none is a prefix of a later one (regex engines agree)", () => {
    BODY_SAFE_TOKENS.forEach((a, i) => BODY_SAFE_TOKENS.slice(i + 1).forEach((b) => expect(b.startsWith(a)).toBe(false)));
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

describe("keyWords", () => {
  it.each(KEY_WORD_CASES)("splits %j", (key, words) => expect(keyWords(key)).toEqual(words));
});

const REFUSED = [
  "BankAcctNum", "compensation", "hourlyRate", "wage", "ssn_last4", "employeeSsn", "PrimaryTaxIdentifier", "ein",
  "api_key", "id_token", "webhook_secret", "ssn", "SSN", "taxId", "tax_identifier", "AcctNum", "account-number",
  "bankAccountNumber", "routingNumber", "IBAN", "billRate", "costRate", "payRate", "bill_rate", "salary", "pin",
  "password", "passwd", "secret", "clientSecret", "accessToken", "refresh_token", "socialSecurityNumber", "payroll",
  "accountNo", "privateKey", "apiKey", "credentials", "swift", "bic", "tin", "sin", "rate_bill", "hourly.rate",
  // round 3: punctuation, plurals, acronym plurals, case and zero-width evasions, new contained terms
  "S.S.N.", "s_sn", "S-S-N", "ssns", "pins", "ibans", "rates_bill", "tokens", "SSNs", "PINs", "IBANs", "acctno", "AcctNo",
  "FEIN", "fein", "ITIN", "itin", "authorization", "Authorization", "cookie", "Cookies", "passcode", "pwd", "billingrate",
  "billing_rate", "sSN", "ssN", "s\u200bsn", "ss\u200dn", "ssn\ufeff", "clientsecrets", "account_no", "AccountNo",
  "accountno", "secretKey", "secrets", "refreshTokens", "billRates", "secretkey",
];
const ALLOWED = [
  "SyncToken", "nextPageToken", "pageToken", "deltaToken", "classname", "pinned", "Id", "TotalAmt", "rate", "Rate",
  "pinning", "single", "winner", "operate", "tokenizer", "generate", "ratio", "CurrencyRef", "MetaData",
  "nextSyncToken", "startPageToken", "secretary", "accountNotes", "Secretary", "rates", "Rates", "spinner",
  "!deep", "__proto__",
];

describe("hasForbiddenField", () => {
  it.each(REFUSED.map((k) => [k]))("refuses %s at the top level, nested, and in arrays", (k) => {
    expect(hasForbiddenField({ [k]: "x" })).toBe(true);
    expect(hasForbiddenField({ a: [{ [k]: "x" }] }, "quickbooks")).toBe(true);
  });
  it("refuses a nested bank object", () => {
    expect(hasForbiddenField({ bank: { routing: "x", account: "y" } })).toBe(true);
    expect(hasForbiddenField({ bank: { account: "y" } })).toBe(false);
  });
  it.each(ALLOWED.map((k) => [k]))("passes %s", (k) => expect(hasForbiddenField({ [k]: "x" }, "quickbooks")).toBe(false));
  it("bare rate is refused for timesolv only; hourlyRate for everyone", () => {
    expect(hasForbiddenField({ Rate: 1 }, "timesolv")).toBe(true);
    expect(hasForbiddenField({ Rate: 1 }, "stripe")).toBe(false);
    expect(hasForbiddenField({ Rate: 1 })).toBe(false);
    expect(hasForbiddenField({ hourlyRate: 1 }, "stripe")).toBe(true);
  });
  it("fails closed when too deep and passes ordinary payloads", () => {
    let deep: unknown = { x: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(hasForbiddenField(deep)).toBe(true);
    expect(hasForbiddenField({ Id: "1", TotalAmt: "10.00", pinned: true, SyncToken: "0" })).toBe(false);
  });
  it("assertNoForbiddenFields throws invalid_input without echoing, and honours the provider", () => {
    expect(kind(() => assertNoForbiddenFields([{ payload: { ssn: "000-00-0000" } }]))).toBe("invalid_input");
    expect(() => assertNoForbiddenFields([{ payload: { ssn: "000-00-0000" } }])).toThrow(/^(?!.*(ssn|000)).*$/i);
    expect(kind(() => assertNoForbiddenFields([{ provider: "timesolv", payload: { Rate: 1 } }]))).toBe("invalid_input");
    expect(kind(() => assertNoForbiddenFields([{ provider: "stripe", payload: { Rate: 1 } }]))).toBe("ok");
  });
  it("fails closed with invalid_input past the distinct-key cap", () => {
    const wide = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));
    expect(hasForbiddenField(wide(MAX_DISTINCT_KEYS))).toBe(false);
    expect(kind(() => hasForbiddenField(wide(MAX_DISTINCT_KEYS + 1)))).toBe("invalid_input");
    expect(kind(() => hasBodyField(wide(MAX_DISTINCT_KEYS + 1)))).toBe("invalid_input");
  });
  it("a 5k-key payload is scanned quickly", () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`field${i}Name`, 1]));
    const t = Date.now();
    expect(hasForbiddenField(wide)).toBe(false);
    expect(hasBodyField(wide)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("key length and cost", () => {
  it("refuses a key over 256 characters (code points) and accepts 256", () => {
    expect(keyTooLong("a".repeat(256))).toBe(false);
    expect(keyTooLong("a".repeat(257))).toBe(true);
    expect(keyTooLong("\u{1F600}".repeat(256))).toBe(false);
    expect(keyTooLong("\u{1F600}".repeat(257))).toBe(true);
    expect(kind(() => hasForbiddenField({ ["k".repeat(257)]: 1 }))).toBe("invalid_input");
    expect(kind(() => hasBodyField({ a: { ["k".repeat(257)]: 1 } }))).toBe("invalid_input");
    expect(kind(() => hasForbiddenField({ ["k".repeat(256)]: 1 }))).toBe("ok");
    expect(kind(() => stripForbidden({ ["k".repeat(257)]: 1 }))).toBe("invalid_input");
    expect(payloadProblem({ a: [{ ["k".repeat(257)]: 1 }] })).toBe("long_key");
    expect(payloadProblem({ ["k\u0000"]: 1 })).toBe("nul");
    expect(payloadProblem({ a: "x\u0000" })).toBe("nul");
    expect(payloadProblem({ a: "x" })).toBeNull();
  });
  it.each([
    ["uppercase run", "A".repeat(80_000)],
    ["camel run", "aB".repeat(40_000)],
    ["acronym then lower", "A".repeat(79_999) + "a"],
    ["digits", "1a".repeat(40_000)],
  ])("an 80k-character key (%s) is refused in well under 100 ms", (_n, key) => {
    const t = performance.now();
    expect(kind(() => hasForbiddenField({ [key]: 1 }))).toBe("invalid_input");
    expect(kind(() => hasBodyField({ [key]: 1 }))).toBe("invalid_input");
    expect(payloadProblem({ [key]: 1 })).toBe("long_key");
    expect(performance.now() - t).toBeLessThan(100);
  });
  it("keyWords is linear on a long uppercase run (no quadratic backtracking)", () => {
    const t = performance.now();
    keyWords("A".repeat(80_000) + "a");
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("evasion probes", () => {
  it("refuses a forbidden word whatever the case, punctuation or zero-width characters", () => {
    for (const k of ["S.S.N.", "s_sn", "sSN", "ssN", "s\u200bsn", "SSNs", "ssns", "p.i.n", "IBANs"]) expect(hasForbiddenField({ [k]: 1 })).toBe(true);
  });
  it("keeps the documented safe names and avoids the secretary / accountNotes false positives", () => {
    for (const k of ["SyncToken", "nextPageToken", "nextSyncToken", "startPageToken", "classname", "pinned", "secretary", "accountNotes"]) {
      expect(hasForbiddenField({ [k]: 1 })).toBe(false);
    }
  });
  it("rates is like rate", () => {
    expect(hasForbiddenField({ rates: 1 }, "stripe")).toBe(false);
    expect(hasForbiddenField({ rates: 1 }, "timesolv")).toBe(true);
    expect(hasForbiddenField({ hourlyRates: 1 }, "stripe")).toBe(true);
  });
  it("lists the known containment false positives instead of hiding them", () => {
    // fein/itin/wage are substring terms: caffeine, itinerary, sewage are refused (fail closed; allowlist projection avoids them)
    expect(hasForbiddenField({ itinerary: 1 })).toBe(true);
    expect(hasForbiddenField({ caffeine: 1 })).toBe(true);
  });
  it("a key literally named !deep is an ordinary key", () => {
    expect(hasForbiddenField({ "!deep": 1 })).toBe(false);
    expect(hasBodyField({ "!deep": 1 })).toBe(false);
  });
});

describe("stripForbidden", () => {
  it("copies an own __proto__ key as data and does not touch the prototype", () => {
    const input = JSON.parse('{"Id": "1", "__proto__": {"polluted": true, "ssn": "x"}, "ok": 2}') as Record<string, unknown>;
    const { payload, removed } = stripForbidden(input);
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(Object.keys(payload)).toEqual(["Id", "__proto__", "ok"]);
    expect(Object.getOwnPropertyDescriptor(payload, "__proto__")?.value).toEqual({ polluted: true });
    expect((payload as { polluted?: boolean }).polluted).toBeUndefined();
    expect(removed).toEqual(["__proto__.ssn"]);
  });
  it("removes forbidden keys at any depth and reports key paths only", () => {
    const input = { Id: "1", ssn: "000-00-0000", Line: [{ Amt: 1, hourlyRate: 99 }], bank: { routing: "r", name: "n" }, SyncToken: "0" };
    const snapshot = JSON.stringify(input);
    const { payload, removed } = stripForbidden(input, "quickbooks");
    expect(payload).toEqual({ Id: "1", Line: [{ Amt: 1 }], bank: { name: "n" }, SyncToken: "0" });
    expect(removed).toEqual(["ssn", "Line[0].hourlyRate", "bank.routing"]);
    expect(JSON.stringify(removed)).not.toMatch(/000|99/);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(hasForbiddenField(payload, "quickbooks")).toBe(false);
  });
  it("applies the provider rule and returns an empty list when nothing is removed", () => {
    expect(stripForbidden({ Rate: 1, id: 2 }, "timesolv")).toEqual({ payload: { id: 2 }, removed: ["Rate"] });
    expect(stripForbidden({ Rate: 1 }, "stripe")).toEqual({ payload: { Rate: 1 }, removed: [] });
  });
  it("fails closed on very deep payloads", () => {
    let deep: unknown = { x: 1 };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(kind(() => stripForbidden(deep))).toBe("invalid_input");
  });
});

describe("hasNul", () => {
  it("finds U+0000 in strings and keys at any depth", () => {
    expect(hasNul({ a: [{ b: "x\u0000y" }] })).toBe(true);
    expect(hasNul({ ["k\u0000"]: 1 })).toBe(true);
    expect(hasNul({ a: "\\u0000 literal", b: [1, null, true] })).toBe(false);
  });
});

describe("lists match the database", () => {
  const dir = new URL("../../../../supabase/core/supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).filter((f) => f.endsWith("_raw_source_records.sql"));
  const sql = readFileSync(new URL(file[0] as string, dir), "utf8");
  const quoted = (s: string) => [...s.matchAll(/'([a-z0-9 ]+)'/g)].map((m) => m[1] as string);
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
    expect(arrayOf("forbidden_words")).toEqual([...FORBIDDEN_WORDS]);
    expect(arrayOf("forbidden_contained")).toEqual([...FORBIDDEN_CONTAINED]);
    expect(arrayOf("forbidden_word_ends")).toEqual([...FORBIDDEN_WORD_ENDS]);
    expect(arrayOf("token_safe_names")).toEqual([...TOKEN_SAFE_NAMES]);
    expect(arrayOf("rate_neighbours")).toEqual([...RATE_NEIGHBOURS]);
  });
  it("the pgTAP key_words fixtures are the same ones tested here", () => {
    const test = readFileSync(new URL("../../../../supabase/core/supabase/tests/110_raw_source_records.test.sql", import.meta.url), "utf8");
    for (const [key] of KEY_WORD_CASES) expect(test).toContain(key === "" ? "raw.key_words('')" : `raw.key_words(E'${key}')`);
  });
  it("normalises like the database", () => {
    expect(normalizeKey("Body-Préview_1")).toBe("bodypreview1");
  });
});
