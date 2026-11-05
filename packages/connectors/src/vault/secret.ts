// A credential in memory (T-033). Tokens leave the Vault only wrapped in a SecretValue: every way a value usually
// escapes (JSON for API responses and RSC payloads, string conversion for logs and prompt templates, Node's inspect
// for console output) prints "[redacted]". The plain string comes out only through `reveal()`, a restricted name
// (lint: packages/connectors only), at the moment it goes into an Authorization header or a refresh request.
//
// Every revealed-able value is also registered with the redactor, so if a provider echoes a token back in an error
// body, the shared logger and `redactText` scrub it by exact match. The registry itself never leaves this module: the
// redactor gets `scrubKnownSecrets` (text in, text out), and `rememberSecret` / `forgetSecretsForTests` are restricted
// names (lint: the token vault only; T-033 security review H1).

export const REDACTED = "[redacted]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Shortest value worth scrubbing by exact match; shorter strings would cause false hits in ordinary text. */
const MIN_KNOWN_LENGTH = 8;
/** Bounded: oldest values drop out first (tokens rotate; a long-running process must not grow without limit). */
const MAX_KNOWN = 2048;
const known = new Set<string>();
/** `known` longest first (an encoded form is replaced whole before a shorter value it contains); rebuilt after changes. */
let longestFirst: string[] | null = null;

/** Token-set fields that hold a credential (access_token, refreshToken, client_secret). Scope, expiry etc. are not registered. */
const CREDENTIAL_FIELD = /(token|secret|password|key)$/i;

/** The forms a value takes when a provider echoes it back: URL-encoded, base64 (standard and URL-safe), hex, JSON-escaped. */
function encodedForms(v: string): string[] {
  const bytes = Buffer.from(v, "utf8");
  const forms = [
    encodeURIComponent(v),
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    JSON.stringify(v).slice(1, -1),
  ];
  return forms.filter((f) => f !== v);
}

function add(v: string): void {
  if (v.length < MIN_KNOWN_LENGTH) return;
  for (const form of [v, ...encodedForms(v)]) {
    known.delete(form);
    known.add(form);
  }
  while (known.size > MAX_KNOWN) known.delete(known.values().next().value as string);
  longestFirst = null;
}

/** Remember a credential so redaction can scrub it by exact match. Also registers the credential fields of a token set. */
export function rememberSecret(value: string): void {
  add(value);
  // A stored token set is JSON ({"access_token": "...", "refresh_token": "..."}): register its credential fields too.
  if (value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && CREDENTIAL_FIELD.test(k)) add(v);
      }
    } catch {
      // not JSON: the whole value is registered already
    }
  }
}

/** `text` with every credential this process has held replaced by `mark`. For the redactor only. */
export function scrubKnownSecrets(text: string, mark: string): string {
  longestFirst ??= [...known].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of longestFirst) {
    if (out.includes(secret)) out = out.split(secret).join(mark);
  }
  return out;
}

/** Test helper: forget every registered value. */
export function forgetSecretsForTests(): void {
  known.clear();
  longestFirst = null;
}

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError("SecretValue needs a non-empty string");
    this.#value = value;
    rememberSecret(value);
    Object.freeze(this);
  }

  /** The plain credential. Restricted name: call only where it goes straight to the provider. */
  reveal(): string {
    // Re-registered on use, so a credential still in use is not the one evicted from the bounded registry.
    rememberSecret(this.#value);
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `SecretValue(${REDACTED})`;
  }
}

export function isSecretValue(value: unknown): value is SecretValue {
  return value instanceof SecretValue;
}
