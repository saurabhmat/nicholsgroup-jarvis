// Redaction for anything a connector writes out (T-033): logs, error messages stored in core.connections.last_error /
// sync_runs.error (T-196 error log), and anything handed to callers. Three layers:
// 1. Exact match: every credential this process has held (SecretValue registers it, with its encoded forms) is
//    replaced wherever it appears, so a provider echoing a token back in an error body is still scrubbed.
// 2. Embedded shapes: Authorization / API-key header values, credential query parameters, credential JSON and
//    key-value fields, JWTs/JWEs, and any word that looks like a vendor key (the shared secret-pattern list).
// 3. Field level (`redactFields`): credential-, financial- and content-named keys dropped; everything else kept with
//    its detail (a ConnectorError keeps kind, status, provider codes), so logs stay useful for T-034/T-040/T-196.
import { looksLikeSecretValue } from "@nichols/core/secrets";
import { isSecretValue, REDACTED, scrubKnownSecrets } from "../vault/secret";

export { REDACTED };

/** Placeholder while redacting: no word-separator characters, so a redacted URL stays one word. */
const MARK = "⁣REDACTED⁣";
/** Longer input is cut before redacting (the patterns are linear, but a log line has no business being bigger). */
const MAX_TEXT = 64 * 1024;

/** Credential names safe to match anywhere (in `x=...` and `x: ...`): nobody uses them for anything else. */
const CREDENTIAL_NAMES = "access_?token|refresh_?token|id_?token|client_?secret|api_?key|apikey|password";
/** Names that are credentials only as URL parameters (`?code=`, `&key=`); in prose `code=6000` is not a secret. */
const QUERY_ONLY_NAMES = "code|token|key|sig|signature|secret";

const EMBEDDED: readonly (readonly [RegExp, string])[] = [
  // Authorization headers, whatever the scheme (Bearer, Basic, Token, Digest or none): the scheme is kept.
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, `$1$2${MARK}`],
  // API-key headers.
  [/\b((?:x-)?(?:api-key|auth-token|access-token)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, `$1${MARK}`],
  // A bare Bearer / Basic value outside a header, only when long enough to be a credential ("Basic plan" is not).
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `$1 ${MARK}`],
  [/\b(basic)\s+[A-Za-z0-9+/]{16,}={0,2}/gi, `$1 ${MARK}`],
  // Query and fragment parameters.
  [new RegExp(`([?&#;])(${CREDENTIAL_NAMES}|${QUERY_ONLY_NAMES})=[^&\\s"'#]+`, "gi"), `$1$2=${MARK}`],
  // Quoted JSON / JS fields, snake_case or camelCase, single or double quotes.
  [new RegExp(`(["'])(${CREDENTIAL_NAMES}|secret|token)\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4)[^\\\\])*\\4`, "gi"), `$1$2$1$3$4${MARK}$4`],
  // Unquoted `access_token: x` / `client_secret=x` (logs, YAML, form bodies).
  [new RegExp(`\\b(${CREDENTIAL_NAMES})(\\s*[:=]\\s*)(?!["'\\s])[^\\s,;&}"']+`, "gi"), `$1$2${MARK}`],
  // JWTs, and JWEs with an empty second segment (Intuit refresh tokens).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g, MARK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, MARK],
];
/** Words are split on whitespace and punctuation that cannot be part of a key, then checked one by one. */
const WORD_SPLIT = /([\s,;:="'`()<>[\]{}|]+)/;
/** Plain snake_case words (`re_authorization_required`, `secret_key_required`) are error codes, not keys: keys have digits or mixed case. */
const IDENTIFIER = /^[a-z]+(?:_[a-z]+)+$/;

const finish = (text: string) => text.split(MARK).join(REDACTED);

/** Free text with every credential replaced by "[redacted]". */
export function redactText(text: string): string {
  let out = scrubKnownSecrets(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, MARK);
  for (const [pattern, replacement] of EMBEDDED) out = out.replace(pattern, replacement);
  return finish(
    out
      .split(WORD_SPLIT)
      // Words already redacted above (e.g. a URL whose `code=` value is now "[redacted]") are left as they are.
      .map((part) =>
        part.length >= 8 && !WORD_SPLIT.test(part) && !part.includes(MARK) && !IDENTIFIER.test(part) && looksLikeSecretValue(part)
          ? MARK
          : part,
      )
      .join(""),
  );
}

/**
 * An identifier from a provider (error code, transaction id): known credentials are scrubbed, and the whole value is
 * replaced only when it looks like a credential itself. No shape patterns, so `secret_key_required` stays readable.
 */
export function redactId(value: string): string {
  const out = scrubKnownSecrets(value.slice(0, MAX_TEXT), MARK);
  return !IDENTIFIER.test(out) && looksLikeSecretValue(out) ? REDACTED : finish(out);
}

// ---------------------------------------------------------------- fields (logs)

const MAX_DEPTH = 6;
const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_KEYS = 100;
const MAX_JSON_CHARS = 16_000;

/** Word parts (after splitting camelCase, snake_case, kebab-case; plurals too) that mark a field to drop from a log. */
const DROP_PARTS = new Set([
  // credentials
  "token", "secret", "password", "passwd", "pwd", "apikey", "key", "private", "credential", "authorization", "auth",
  "cookie", "session", "bearer", "signature", "sig", "otp", "totp", "jwt", "code",
  // financial data the portal never stores (CLAUDE.md, architecture §7)
  "ssn", "routing", "iban", "card", "cvv", "salary", "salarie", "compensation",
  // content (CLAUDE.md rule 6: no bodies)
  "body", "bodie", "content", "html", "raw", "payload", "attachment", "snippet", "subject", "prompt", "completion", "transcript",
]);
/** Kept although a part matches: ConnectorErrorInfo fields, expiries and error codes, counters. */
const KEEP_KEYS = new Set(["provider_error_code", "provider_tid", "input_tokens", "output_tokens", "max_tokens", "idempotency_key", "status_code"]);
const KEEP_SUFFIX = /(_expires_at|_error_code)$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** True for a field name a log entry must not carry (accessToken, client_secret, email_body, auth_code). */
export function isDroppedLogKey(key: string): boolean {
  const k = snake(key);
  if (KEEP_KEYS.has(k) || KEEP_SUFFIX.test(k)) return false;
  const parts = k.split(/[^a-z0-9]+/).filter(Boolean);
  const hit = (p: string) => DROP_PARTS.has(p) || (p.endsWith("s") && DROP_PARTS.has(p.slice(0, -1)));
  return parts.some(hit) || parts.join("").includes("apikey") || parts.join("").includes("accesskey");
}

const isPlain = (v: object) => {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

function scrub(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const r = redactText(value);
    return r.length > MAX_STRING ? `${r.slice(0, MAX_STRING)}…[truncated]` : r;
  }
  if (typeof value !== "object") return undefined; // functions, symbols, undefined: dropped
  if (isSecretValue(value)) return REDACTED;
  if (value instanceof Error) {
    // A ConnectorError (or any error with a toJSON) keeps its safe fields: kind, http_status, provider codes, endpoint.
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    const json: unknown = typeof toJSON === "function" ? (toJSON as () => unknown).call(value) : undefined;
    if (json !== null && typeof json === "object" && !Array.isArray(json)) return { error_name: value.name, ...(scrub(json, depth + 1) as object) };
    return { error_name: value.name, error_summary: redactText(value.message).slice(0, 500) };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[binary]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => scrub(v, depth + 1) ?? null);
  if (!isPlain(value)) return "[object]"; // Map, Set, class instances: never walked
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const k of Object.keys(value)) {
    if (kept >= MAX_KEYS) {
      out._more_keys = true;
      break;
    }
    if (UNSAFE_KEYS.has(k) || isDroppedLogKey(k)) continue;
    const r = scrub((value as Record<string, unknown>)[k], depth + 1);
    if (r !== undefined) {
      out[k] = r;
      kept += 1;
    }
  }
  return out;
}

/** Structured fields safe to write out (logs, error records). Never throws: a field that throws while read drops the entry's fields. */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  let out: unknown;
  try {
    out = scrub(fields, 0);
  } catch {
    return { _unreadable: true };
  }
  if (out === null || typeof out !== "object" || Array.isArray(out)) return {};
  return JSON.stringify(out).length > MAX_JSON_CHARS ? { _truncated: true } : (out as Record<string, unknown>);
}
