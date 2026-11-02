// Redaction for anything a connector writes out (T-033): logs, error messages stored in core.connections.last_error /
// sync_runs.error (T-196 error log), and anything handed to callers. Three layers:
// 1. Exact match: every credential this process has held (SecretValue registers it) is replaced wherever it appears,
//    so a provider echoing a token back in an error body is still scrubbed.
// 2. Embedded shapes: Authorization values, credential query parameters, credential JSON fields, JWTs, and any word
//    that looks like a vendor key (the shared secret-pattern list) inside free text.
// 3. Field level (`redactFields`): the audit redactor (credential-, personal- and content-named keys dropped, values
//    checked, bounded size), after layers 1-2 ran on every string.
import { redactMetadata } from "@nichols/core/audit";
import { looksLikeSecretValue } from "@nichols/core/secrets";
import { isSecretValue, knownSecrets, REDACTED } from "../vault/secret";

export { REDACTED };

/** Placeholder while redacting: no word-separator characters, so a redacted URL stays one word. */
const MARK = "\u2063REDACTED\u2063";

const EMBEDDED: readonly (readonly [RegExp, string])[] = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MARK}`],
  [/([?&#;]|\b)(access_token|refresh_token|id_token|client_secret|code|token|key|api_key|sig|signature|password)=[^&\s"'#]+/gi, `$1$2=${MARK}`],
  [/"(access_token|refresh_token|id_token|client_secret|password|api_key|apikey|secret|token)"\s*:\s*"[^"]*"/gi, `"$1":"${MARK}"`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MARK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MARK],
];
/** Words are split on whitespace and punctuation that cannot be part of a key, then checked one by one. */
const WORD_SPLIT = /([\s,;"'`()<>[\]{}|]+)/;

/** Free text with every credential replaced by "[redacted]". */
export function redactText(text: string): string {
  let out = text;
  for (const secret of knownSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join(MARK);
  }
  for (const [pattern, replacement] of EMBEDDED) out = out.replace(pattern, replacement);
  return out
    .split(WORD_SPLIT)
    // Words already redacted above (e.g. a URL whose `code=` value is now "[redacted]") are left as they are.
    .map((part) =>
      part.length >= 8 && !WORD_SPLIT.test(part) && !part.includes(MARK) && looksLikeSecretValue(part) ? MARK : part,
    )
    .join("")
    .split(MARK)
    .join(REDACTED);
}

const MAX_DEPTH = 6;

/** Layers 1-2 on every string; SecretValue, Error and other non-plain values made safe before field redaction. */
function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (isSecretValue(value)) return REDACTED;
  if (value instanceof Error) return { error_name: value.name, error_summary: redactText(value.message).slice(0, 500) };
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value; // left to redactMetadata ("[object]", Date, binary)
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, depth + 1)]));
}

/** Structured fields safe to write out (logs, error records). */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const scrubbed = scrub(fields, 0);
  return redactMetadata(scrubbed as Record<string, unknown>);
}
