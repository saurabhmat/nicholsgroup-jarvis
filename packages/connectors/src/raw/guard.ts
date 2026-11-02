// Content-body guard (rule 6, T-039). Comms/docs providers' records may carry message or document bodies; those are
// stored only when the lane policy `store_content_bodies` is true. The database repeats this check in a trigger
// (raw.source_records_before_write); keep CONTENT_PROVIDERS and BODY_FIELD_NAMES in step with
// raw.is_content_provider and raw.payload_has_body_field (a test pins both lists).
import { ConnectorError } from "../contract/errors";

/** Providers whose payloads can hold message or document content. */
export const CONTENT_PROVIDERS: readonly string[] = ["google", "microsoft", "notion"];

/** Key names (lower-case, punctuation removed) that mean "body or content". Matched against keys, never values. */
export const BODY_FIELD_NAMES: readonly string[] = [
  "body", "bodypreview", "bodyhtml", "htmlbody", "textbody", "plainbody", "uniquebody", "snippet", "html",
  "htmlcontent", "content", "contenthtml", "text", "textcontent", "plaintext", "richtext", "markdown", "raw",
];

const BODY_SET: ReadonlySet<string> = new Set(BODY_FIELD_NAMES);
const MAX_DEPTH = 16;

export const isContentProvider = (provider: string): boolean => CONTENT_PROVIDERS.includes(provider);

/** Whether the payload has a body-named key at any depth. Fails closed past MAX_DEPTH levels. */
export function hasBodyField(payload: unknown): boolean {
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
      if (BODY_SET.has(k.replace(/[^A-Za-z0-9]/g, "").toLowerCase())) return true;
      stack.push([v, depth + 1]);
    }
  }
  return false;
}

/**
 * Throws `forbidden` when a comms/docs record has a body field and the lane does not store bodies. The message names
 * neither the key nor any value (the record is never echoed).
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
