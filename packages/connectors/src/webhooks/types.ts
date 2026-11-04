// Webhook receiver contract (T-036). A provider plugs into the shared pipeline (handler.ts) by supplying a
// `WebhookProvider`: how to get its signing secret, how to verify a request, and how to read the events out of a
// verified body. The pipeline owns everything else (method, size, content type, timestamp, dedupe, lane, enqueue).
import type { SecretValue } from "../vault/secret";
import type { Provider } from "../contract/schemas";

/** Why a verifier refused. Logged, never sent to the caller (every refusal answers 401 with the same body). */
export type VerifyRefusal = "missing_signature" | "malformed_signature" | "bad_signature" | "missing_timestamp";

export type VerifyResult =
  | { ok: true; /** When the provider signed the request (from the signed data), or null if it carries no timestamp. */ signedAt: Date | null }
  | { ok: false; reason: VerifyRefusal };

export interface VerifyInput {
  /** The request body exactly as received (before any parsing). */
  readonly body: Uint8Array;
  readonly headers: Headers;
  readonly secret: SecretValue;
  readonly now: Date;
}

/**
 * Raw bytes plus headers in, verified or refused out. Must compare in constant time (use `safeEqual`), must not throw
 * for bad input (a throw is treated as a refusal), and must not read anything but its inputs.
 */
export interface WebhookVerifier {
  verify(input: VerifyInput): VerifyResult;
}

/** One event read from a VERIFIED body. Ids only: nothing here may carry content. */
export interface WebhookEvent {
  /** The provider account the event is about (QuickBooks realmId, Stripe account, mailbox, workspace). Never a lane. */
  readonly accountId: string;
  /** Unique per event within the provider. If the provider sends none, derive a stable one from the event's ids. */
  readonly eventId: string;
  readonly eventType: string;
  /** Changed objects, ids only (at most 100). */
  readonly refs: readonly { type: string; id: string }[];
}

export type ParseResult = { ok: true; events: readonly WebhookEvent[] } | { ok: false };

export interface WebhookProvider {
  readonly provider: Provider;
  readonly verifier: WebhookVerifier;
  /**
   * The signing secret, or null/undefined (or a throw) when it is not configured: the route then answers 503 and
   * enqueues nothing (fail closed). Read it through `requireConnectorEnv` or the Vault, never from process.env.
   */
  readonly getSecret: () => SecretValue | null | undefined;
  /** Accepted media types (lowercase, no parameters), e.g. ["application/json"]. Anything else answers 415. */
  readonly contentTypes: readonly string[];
  /**
   * Seconds a signed timestamp may differ from now (either direction). `null` means the provider signs no timestamp,
   * so replay protection rests on event-id dedupe alone; it must be chosen explicitly.
   */
  readonly toleranceSeconds: number | null;
  /** Body cap in bytes (default 1 MiB, never more than 4 MiB). */
  readonly maxBodyBytes?: number;
  /** Reads events from the verified body. Must not throw; return { ok: false } for anything unexpected. */
  parse(body: Uint8Array): ParseResult;
}
