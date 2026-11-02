// Content-body and forbidden-data guards (rules 6 and 7, T-039). The database repeats both checks in a trigger
// (raw.source_records_before_write, authoritative); keep every list here in step with the raw.* list functions in
// the migration (a test pins them all).
//
// Content guard: content providers' records may carry message, document, task or narrative text; those are stored only
// when the lane policy `store_content_bodies` is true. A key is a body field when its normalised form equals an exact
// name, or contains a substring after the safe tokens (metadata such as contentType) are removed.
// Forbidden-data guard: for every provider, keys naming SSNs, bank identifiers, rates or credentials are refused.
// Connectors must strip these fields before storing.
import { ConnectorError } from "../contract/errors";

/** Providers whose payloads can hold message, document, task or narrative content. */
export const CONTENT_PROVIDERS: readonly string[] = ["google", "microsoft", "notion", "monday", "gohighlevel", "timesolv"];

export const BODY_EXACT_NAMES: readonly string[] = ["raw"];
export const BODY_SUBSTRINGS: readonly string[] = [
  "body", "content", "text", "description", "notes", "snippet", "html", "markdown", "message",
  "comment", "attachment", "bytes", "values", "dataurl", "narrative",
];
/** Longest first (same order as SQL, so removal behaves the same). */
export const BODY_SAFE_TOKENS: readonly string[] = [
  "contentdisposition", "contentlanguage", "contentencoding", "attachmentcount", "hasattachments",
  "contentlength", "contenttype", "attachmentid", "hasattachment", "messagecount", "commentcount",
  "textcolor", "messageids", "messageid", "commentid", "contentmd5", "contentid", "context",
];
export const FORBIDDEN_NAMES: readonly string[] = [
  "ssn", "socialsecuritynumber", "taxid", "taxidentifier", "acctnum", "accountnumber",
  "bankaccountnumber", "routingnumber", "iban", "billrate", "costrate", "salary", "payrate", "pin",
  "password", "secret", "clientsecret", "accesstoken", "refreshtoken",
];

const EXACT = new Set(BODY_EXACT_NAMES);
const FORBIDDEN = new Set(FORBIDDEN_NAMES);
const SAFE_RE = new RegExp(BODY_SAFE_TOKENS.join("|"), "g");
const MAX_DEPTH = 16;

export const isContentProvider = (provider: string): boolean => CONTENT_PROVIDERS.includes(provider);

/** NFKD fold (strips accents, folds full-width), lower-case, keep a-z0-9 only. Same as raw.normalize_key. */
export const normalizeKey = (key: string): string => key.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

const isBodyKey = (nk: string): boolean => {
  if (EXACT.has(nk)) return true;
  const rest = nk.replace(SAFE_RE, "");
  return BODY_SUBSTRINGS.some((s) => rest.includes(s));
};

/** Whether any key at any depth satisfies `test`. Fails closed (true) when anything sits 16 or more levels down. */
function anyKey(payload: unknown, test: (normalised: string) => boolean): boolean {
  const stack: [unknown, number][] = [[payload, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    // Same rule as the SQL walk: any value (scalar included) at depth 16 or more counts.
    if (depth >= MAX_DEPTH) return true;
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) stack.push([v, depth + 1]);
      continue;
    }
    for (const [k, v] of Object.entries(value)) {
      if (test(normalizeKey(k))) return true;
      stack.push([v, depth + 1]);
    }
  }
  return false;
}

/** Whether the payload has a body-named key at any depth. Fails closed past MAX_DEPTH levels. */
export const hasBodyField = (payload: unknown): boolean => anyKey(payload, isBodyKey);

/** Whether the payload has a forbidden key (SSN, bank, rate, credential) at any depth. Fails closed when too deep. */
export const hasForbiddenField = (payload: unknown): boolean => anyKey(payload, (nk) => FORBIDDEN.has(nk));

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
export function assertNoForbiddenFields(records: readonly { payload: unknown }[]): void {
  for (const r of records) {
    if (hasForbiddenField(r.payload)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A raw record carries a field that must not be stored" });
    }
  }
}
