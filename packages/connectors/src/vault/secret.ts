// A credential in memory (T-033). Tokens leave the Vault only wrapped in a SecretValue: every way a value usually
// escapes (JSON for API responses and RSC payloads, string conversion for logs and prompt templates, Node's inspect
// for console output) prints "[redacted]". The plain string comes out only through `reveal()`, a restricted name
// (lint: packages/connectors only), at the moment it goes into an Authorization header or a refresh request.
//
// Every revealed-able value is also registered with the redactor (`knownSecrets`), so if a provider echoes a token
// back in an error body, the shared logger and `redactText` scrub it by exact match.

export const REDACTED = "[redacted]";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Shortest value worth scrubbing by exact match; shorter strings would cause false hits in ordinary text. */
const MIN_KNOWN_LENGTH = 8;
/** Bounded: oldest values drop out first (tokens rotate; a long-running process must not grow without limit). */
const MAX_KNOWN = 512;
const known = new Set<string>();

/** Remember a credential so redaction can scrub it by exact match. Also registers the JSON fields of a token set. */
export function rememberSecret(value: string): void {
  const add = (v: string) => {
    if (v.length < MIN_KNOWN_LENGTH) return;
    known.delete(v);
    known.add(v);
    if (known.size > MAX_KNOWN) known.delete(known.values().next().value as string);
  };
  add(value);
  // A stored token set is JSON ({"access_token": "...", "refresh_token": "..."}): register each string field too.
  if (value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        for (const v of Object.values(parsed)) if (typeof v === "string") add(v);
      }
    } catch {
      // not JSON: the whole value is registered already
    }
  }
}

/** Credentials seen by this process, newest last. For the redactor only. */
export function knownSecrets(): Iterable<string> {
  return known;
}

/** Test helper: forget every registered value. */
export function forgetSecretsForTests(): void {
  known.clear();
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
