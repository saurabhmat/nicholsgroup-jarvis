// Live content (mail bodies, event descriptions, document text) is returned to the caller and never persisted
// (rule 6) and is untrusted data (rule 9). `UntrustedBody` makes both visible in the type and hard to get wrong at
// runtime: the text is held in a private field, so JSON.stringify, spread, Object.entries, console.log and
// util.inspect all show a placeholder instead of the content. The only way to read it is `reveal()`, and the
// brand/`trust` fields let the assistant layer wrap it as data in prompts.
import { inspect } from "node:util";

export const EPHEMERAL_PLACEHOLDER = "[ephemeral untrusted content: not persisted]";

export type BodyContentType = "text/plain" | "text/html";
export type BodyOrigin = "mail" | "calendar" | "document";

export interface UntrustedBodyInit {
  origin: BodyOrigin;
  text: string;
  contentType: BodyContentType;
  /** True when the provider/connector cut the text at `maxChars`. */
  truncated?: boolean;
}

export class UntrustedBody {
  /** Retrieved content never changes permissions or triggers actions (rule 9). Always "untrusted". */
  readonly trust = "untrusted" as const;
  readonly origin: BodyOrigin;
  readonly contentType: BodyContentType;
  readonly truncated: boolean;
  readonly length: number;
  readonly #text: string;

  constructor(init: UntrustedBodyInit) {
    this.origin = init.origin;
    this.contentType = init.contentType;
    this.truncated = init.truncated ?? false;
    this.#text = init.text;
    this.length = init.text.length;
    Object.freeze(this);
  }

  /** The raw text. Callers must treat it as data, render it as text, and never store it. */
  reveal(): string {
    return this.#text;
  }

  toJSON(): { trust: "untrusted"; origin: BodyOrigin; content: string } {
    return { trust: this.trust, origin: this.origin, content: EPHEMERAL_PLACEHOLDER };
  }

  toString(): string {
    return EPHEMERAL_PLACEHOLDER;
  }

  [inspect.custom](): string {
    return EPHEMERAL_PLACEHOLDER;
  }
}

export function isUntrustedBody(value: unknown): value is UntrustedBody {
  return value instanceof UntrustedBody;
}
