// Content-body and forbidden-data guards (rules 6 and 7, T-039). The database repeats both checks in a trigger
// (raw.source_records_before_write, authoritative); keep every list here in step with the raw.* list functions in
// the migration (a test pins them all).
//
// Content guard: content providers' records may carry message, document, task or narrative text; those are stored only
// when the lane policy `store_content_bodies` is true. A key is a body field when its normalised form equals an exact
// name, or contains a substring after the safe tokens (metadata such as contentType) are removed.
// Forbidden-data guard: for every provider, keys naming SSNs, bank identifiers, rates or credentials are refused
// (word-aware rules, see keyWords and the lists below). Connectors must strip these fields before storing
// (`stripForbidden`). Both guards are DENYLISTS and only a backstop: each adapter must project to a strict allowlist
// per provider and object type.
import { ConnectorError } from "../contract/errors";

/** Providers whose payloads can hold message, document, task or narrative content. */
export const CONTENT_PROVIDERS: readonly string[] = ["google", "microsoft", "notion", "monday", "gohighlevel", "timesolv"];

export const BODY_EXACT_NAMES: readonly string[] = ["raw"];
export const BODY_SUBSTRINGS: readonly string[] = [
  "body", "content", "text", "description", "notes", "snippet", "html", "markdown", "message",
  "comment", "attachment", "bytes", "values", "dataurl", "narrative", "note", "memo", "transcript",
  "preview", "excerpt", "caption",
];
/** Longest first; no token is a prefix of a later one (so leftmost-first and leftmost-longest engines agree). */
export const BODY_SAFE_TOKENS: readonly string[] = [
  "contentdisposition", "contentlanguage", "contentencoding", "attachmentcount", "lastmessagetype",
  "lastmessagedate", "hasattachments", "webcontentlink", "messagesunread", "messagestotal",
  "contentlength", "contenttype", "attachmentid", "hasattachment", "messagecount", "commentcount",
  "textcolor", "messageids", "messageid", "commentid", "contentmd5", "contentid", "htmllink",
  "context",
];
/** Forbidden: a word of the key equals one of these (whole words only: `classname` and `pinned` pass). */
export const FORBIDDEN_WORDS: readonly string[] = ["ssn", "sin", "ein", "tin", "pin", "iban", "swift", "bic"];
/** Forbidden: the joined, normalised key contains one of these. */
export const FORBIDDEN_CONTAINED: readonly string[] = [
  "socialsecurity", "taxid", "acctnum", "accountnum", "accountno", "routing", "salary", "wage",
  "compensation", "payroll", "password", "passwd", "secret", "apikey", "privatekey", "credential",
  "billrate", "costrate", "payrate", "hourlyrate",
];
/** A key whose last word is `token` is forbidden unless the whole joined key is one of these. */
export const TOKEN_SAFE_NAMES: readonly string[] = ["synctoken", "pagetoken", "nextpagetoken", "deltatoken"];
/** The word `rate` next to one of these is forbidden (hourlyRate); for timesolv, any `rate` word is. */
export const RATE_NEIGHBOURS: readonly string[] = ["bill", "cost", "pay", "hourly"];

const EXACT = new Set(BODY_EXACT_NAMES);
const FWORDS = new Set(FORBIDDEN_WORDS);
const TSAFE = new Set(TOKEN_SAFE_NAMES);
const NEIGH = new Set(RATE_NEIGHBOURS);
const SAFE_RE = new RegExp(BODY_SAFE_TOKENS.join("|"), "g");
const BODY_RE = new RegExp(BODY_SUBSTRINGS.join("|"));
const FORB_RE = new RegExp(FORBIDDEN_CONTAINED.join("|"));
const MAX_DEPTH = 16;
/** Distinct keys per payload; more fails closed (the database enforces the same cap with 22023). */
export const MAX_DISTINCT_KEYS = 20000;

export const isContentProvider = (provider: string): boolean => CONTENT_PROVIDERS.includes(provider);

/** NFKD fold (strips accents, folds full-width), lower-case, keep a-z0-9 only. Same as raw.normalize_key. */
export const normalizeKey = (key: string): string => key.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Words of a key (same as raw.key_words): `employeeSsn` -> [employee, ssn]; `SSNLast4` -> [ssn, last, 4]. */
export const keyWords = (key: string): string[] =>
  key
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");

const isBodyKey = (nk: string): boolean => EXACT.has(nk) || BODY_RE.test(nk.replace(SAFE_RE, ""));

const isForbiddenKey = (key: string, nk: string, provider: string | undefined): boolean => {
  const words = keyWords(key);
  if (words.some((w) => FWORDS.has(w))) return true;
  if (FORB_RE.test(nk)) return true;
  if (!TSAFE.has(nk) && words.some((w) => w.endsWith("token"))) return true;
  return words.some((w, i) => w === "rate" && (provider === "timesolv" || NEIGH.has(words[i - 1] ?? "") || NEIGH.has(words[i + 1] ?? "")));
};

const tooMany = () => new ConnectorError({ kind: "invalid_input", message: "A raw record payload has too many distinct keys" });

/**
 * One walk over every key at any depth: each distinct key is normalised once and tested against both guards (the same
 * shape as raw.payload_scan). Anything 16 or more levels down trips both; more than 20000 distinct keys throws.
 */
function scan(payload: unknown, provider: string | undefined, wantBody: boolean): { forbidden: boolean; body: boolean } {
  const keys = new Set<string>();
  let deep = false;
  const stack: [unknown, number][] = [[payload, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    // Same rule as the SQL walk: any value (scalar included) at depth 16 or more counts.
    if (depth >= MAX_DEPTH) {
      deep = true;
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) stack.push([v, depth + 1]);
      continue;
    }
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      if (keys.size > MAX_DISTINCT_KEYS) throw tooMany();
      stack.push([v, depth + 1]);
    }
  }
  let forbidden = deep;
  let body = deep && wantBody;
  for (const k of keys) {
    if (forbidden && (body || !wantBody)) break;
    const nk = normalizeKey(k);
    if (!forbidden) forbidden = isForbiddenKey(k, nk, provider);
    if (wantBody && !body) body = isBodyKey(nk);
  }
  return { forbidden, body };
}

/** Whether the payload has a body-named key at any depth. Fails closed past 16 levels; throws past the key cap. */
export const hasBodyField = (payload: unknown): boolean => scan(payload, undefined, true).body;

/**
 * Whether the payload has a forbidden key (SSN, bank, rate, credential) at any depth. `provider` enables the
 * provider-specific rule (bare `rate` for timesolv). Fails closed when too deep.
 */
export const hasForbiddenField = (payload: unknown, provider?: string): boolean => scan(payload, provider, false).forbidden;

/** Whether `key` (a single key name) is forbidden; the per-key rule used by the scan and by `stripForbidden`. */
export const isForbiddenKeyName = (key: string, provider?: string): boolean => isForbiddenKey(key, normalizeKey(key), provider);

/**
 * Removes forbidden keys at any depth. Returns a new payload (the input is not modified) and the paths of the removed
 * keys (`a.b[0].c`; key names only, never values). Throws `invalid_input` for a payload nested 16 or more levels (the
 * guards refuse those anyway). Use it in adapters before storing; the guards remain the backstop.
 */
export function stripForbidden<T>(payload: T, provider?: string): { payload: T; removed: string[] } {
  const removed: string[] = [];
  const walk = (value: unknown, path: string, depth: number): unknown => {
    if (depth >= MAX_DEPTH) throw new ConnectorError({ kind: "invalid_input", message: "A raw record payload is nested too deeply" });
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = path === "" ? k : `${path}.${k}`;
      if (isForbiddenKeyName(k, provider)) {
        removed.push(p);
        continue;
      }
      out[k] = walk(v, p, depth + 1);
    }
    return out;
  };
  return { payload: walk(payload, "", 0) as T, removed };
}

/** Whether any key or string value contains U+0000 (jsonb cannot store it). Iterative, any depth. */
export function hasNul(payload: unknown): boolean {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000")) return true;
    } else if (Array.isArray(value)) {
      for (const v of value) stack.push(v);
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) {
        if (k.includes("\u0000")) return true;
        stack.push(v);
      }
    }
  }
  return false;
}

/**
 * Throws `forbidden` when a content-provider record has a body field and the lane does not store bodies. The message
 * names neither the key nor any value (the record is never echoed).
 */
export function assertContentAllowed(
  records: readonly { provider: string; payload: unknown }[],
  policy: { storeContentBodies: boolean },
): void {
  if (policy.storeContentBodies === true) return;
  for (const r of records) {
    if (isContentProvider(r.provider) && hasBodyField(r.payload)) {
      throw new ConnectorError({ kind: "forbidden", message: "Lane policy does not allow storing content bodies" });
    }
  }
}

/** Throws `invalid_input` when any record carries a forbidden field (every provider). Nothing is echoed. */
export function assertNoForbiddenFields(records: readonly { provider?: string; payload: unknown }[]): void {
  for (const r of records) {
    if (hasForbiddenField(r.payload, r.provider)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A raw record carries a field that must not be stored" });
    }
  }
}
