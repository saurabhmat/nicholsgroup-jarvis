// Test doubles for the webhook receiver (T-036): a mock provider that signs with the generic HMAC-SHA256 verifier, a
// signing helper, and an in-memory store with the same claim/mark semantics as core.webhook_event_* (pinned to the
// migration by the pgTAP tests). Synthetic only. Test files import this by relative path.
import type { LaneId } from "@nichols/core";
import { SecretValue } from "../vault/secret";
import { hmacSha256 } from "../webhooks/crypto";
import { hmacSha256Verifier } from "../webhooks/hmac";
import type { ClaimResult, ResolveResult, WebhookStore } from "../webhooks/store";
import type { WebhookProvider } from "../webhooks/types";

export const MOCK_WEBHOOK_SECRET = "mock-webhook-signing-secret-0001";

export interface MockProviderOptions {
  secret?: string | null | (() => never);
  toleranceSeconds?: number | null;
  maxBodyBytes?: number;
  contentTypes?: readonly string[];
}

/** A `monday`-named provider (the contract has no mock provider) whose bodies look like { id, type, account, refs }. */
export function createMockWebhookProvider(options: MockProviderOptions = {}): WebhookProvider {
  const secret = options.secret === undefined ? MOCK_WEBHOOK_SECRET : options.secret;
  return {
    provider: "monday",
    verifier: hmacSha256Verifier({ signatureHeader: "x-mock-signature", encoding: "hex", prefix: "sha256=", timestampHeader: "x-mock-timestamp" }),
    getSecret: () => (typeof secret === "function" ? secret() : secret === null ? null : new SecretValue(secret)),
    contentTypes: options.contentTypes ?? ["application/json"],
    toleranceSeconds: options.toleranceSeconds === undefined ? 300 : options.toleranceSeconds,
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
    parse(body) {
      try {
        const v = JSON.parse(Buffer.from(body).toString("utf8")) as { events?: unknown };
        if (!Array.isArray(v.events)) return { ok: false };
        return {
          ok: true,
          events: v.events.map((e: { id: string; type: string; account: string; refs?: { type: string; id: string }[] }) => ({
            accountId: e.account, eventId: e.id, eventType: e.type, refs: e.refs ?? [],
          })),
        };
      } catch {
        return { ok: false };
      }
    },
  };
}

export const mockBody = (...events: { id: string; type?: string; account: string; refs?: { type: string; id: string }[] }[]) =>
  JSON.stringify({ events: events.map((e) => ({ type: "item.changed", ...e })) });

/** Signed headers for `body` as the mock provider expects them. */
export function signMock(body: string, opts: { secret?: string; timestamp?: number; contentType?: string } = {}): Record<string, string> {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = hmacSha256(opts.secret ?? MOCK_WEBHOOK_SECRET, `${ts}.${body}`).toString("hex");
  return { "content-type": opts.contentType ?? "application/json", "x-mock-timestamp": ts, "x-mock-signature": `sha256=${sig}` };
}

export interface MemoryRow { laneId: LaneId; connectionId: string; provider: string; eventId: string; eventType: string; payloadHash: string; status: "received" | "enqueued" | "failed"; attempts: number }

/** accounts: `provider:lower(account)` -> lane + connection (as core.webhook_resolve_connection would return). */
export function createMemoryWebhookStore(accounts: Record<string, { laneId: LaneId; connectionId: string }[]>, faults: { resolve?: boolean; claim?: boolean } = {}) {
  const rows = new Map<string, MemoryRow>();
  const calls: { resolve: { provider: string; account: string }[]; claim: string[] } = { resolve: [], claim: [] };
  const key = (l: string, p: string, e: string) => `${l}|${p}|${e}`;
  const store: WebhookStore = {
    async resolve(provider, accountId): Promise<ResolveResult> {
      calls.resolve.push({ provider, account: accountId });
      if (faults.resolve) throw new Error("db down");
      const hits = accounts[`${provider}:${accountId.toLowerCase()}`] ?? [];
      const [hit] = hits;
      return !hit ? { kind: "unknown" } : hits.length > 1 ? { kind: "ambiguous" } : { kind: "found", ...hit };
    },
    async claim(laneId, connectionId, provider, event): Promise<ClaimResult> {
      calls.claim.push(`${laneId}|${provider}|${event.id}`);
      if (faults.claim) throw new Error("db down");
      const k = key(laneId, provider, event.id);
      const row = rows.get(k);
      if (!row) {
        rows.set(k, { laneId, connectionId, provider, eventId: event.id, eventType: event.type, payloadHash: event.payloadHash, status: "received", attempts: 1 });
        return "process";
      }
      if (row.status === "failed") {
        Object.assign(row, { status: "received", payloadHash: event.payloadHash, attempts: row.attempts + 1 });
        return "process";
      }
      return row.payloadHash === event.payloadHash ? "duplicate" : "conflict";
    },
    async mark(laneId, provider, eventId, status) {
      const row = rows.get(key(laneId, provider, eventId));
      if (!row || row.status !== "received") return false;
      row.status = status;
      return true;
    },
    async purge() {
      return 0;
    },
  };
  return { store, rows, calls };
}
