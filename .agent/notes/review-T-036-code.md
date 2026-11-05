# T-036 code review (commit b67e25c)

Gates: `pnpm typecheck && pnpm lint && pnpm test` pass (17/17 tasks); `node --test scripts/*.test.mjs` 196 pass. `test:db` not run (per instruction).
Verdict: no BLOCKER, no HIGH. Acceptance (route per provider, raw-body verify interface, tolerance, core.webhook_events + RLS + pgTAP, unsigned/replayed rejected, enqueue not inline) is met. Two MEDIUM items are framework gaps that T-065 and monday will hit; fix cheaply now or log in plan-review.

## MEDIUM
M1. Verifier is synchronous; Google JWT needs async (JWKS fetch). packages/connectors/src/webhooks/types.ts:27 (`verify(): VerifyResult`) and handler.ts:~117 (`entry.verifier.verify(...)` inside try without await).
  Fix now (2-line change): `verify(input): VerifyResult | Promise<VerifyResult>` and `await entry.verifier.verify(...)` inside the try. A rejected promise is then also a refusal. Add one test with an async verifier (accept, refuse, reject). The PR notes it as a "small change", but it changes the contract that T-053/T-058 verifiers compile against, so do it before they land.

M2. Gmail/Pub-Sub has no shared secret, but step 4 (handler.ts ~98) requires `getSecret()` to return a value of at least 16 chars. T-065 would have to return the OIDC audience or a fake as the "secret" to get past the gate, and the fail-closed check then guards the wrong thing.
  Fix: let the provider say what it needs, e.g. `getSecret` returns the verifier's config (audience + expected service-account email) as a SecretValue, documented as "verifier credential", or rename to `getCredential`. Alternatively make the gate `verifier.isConfigured?()`. Decide now; document in the T-065 note.

M3. monday.com challenge handshake is not supported (the PR says "small pre-step in its provider, not in the framework", but there is no hook). monday's first POST is unsigned `{"challenge":"..."}` and must be answered 200 with the same JSON. Today it hits step 7 and gets 401, so the webhook can never be created.
  Fix: optional `handshake?(request headers, body): Response | null` on WebhookProvider, run after body read and before verify (provider returns null for normal deliveries). Must not enqueue or touch the store. Test: challenge echoed, nothing queued, and a normal unsigned body still 401. Also monday signs with a JWT in the `Authorization` header (not HMAC), so it falls under M1/M2 too. Without this hook, the monday task needs a handler edit.

M4. A failed hand-off followed by a failed `mark(...,"failed")` leaves the row `received`; the provider's retry inside 2 minutes then gets `duplicate`, 200, and the event is never queued. handler.ts, the enqueue catch block (`.mark(..."failed").catch(() => false)`).
  Fix: if marking failed also fails, answer 503 anyway (already true because counts.failed>0) and accept that retries within 2 minutes are lost, or make the claim treat `received` older than ~10 s with no queued mark as claimable. Cheapest: shorten the stuck window to 30-60 s (migration line ~claim, `interval '2 minutes'`) and add a test (memory store has no stuck-window semantic, only pgTAP does). Providers retry in seconds to minutes (Intuit, Stripe), so this is realistic only under correlated outage; keep MEDIUM.

M5. Handler tests run against `createMemoryWebhookStore`, a re-implementation of claim/mark semantics, and `enqueue` is a plain mock. Nothing exercises handler -> real `sendLaneEvent` validation. handler.test.ts:318 is titled "exactly the fields of the registered webhook/received schema" but only compares key names; it never validates against `webhookReceived` schema. The pieces that must agree (uuid connectionId, provider regex `^[a-z][a-z0-9_]{1,31}$`, 256/128 length caps, strict refs, `wh:` id) are checked only by hand.
  Fix: in that test, run the queued data through `webhookReceived.schema["~standard"].validate` (events.ts), and add one integration-style test wiring `enqueue: sendLaneEvent` with a mocked Inngest client (as send.test.ts does) to prove `id` reaches `getInngest().send` and a handler-built event passes validation. Also validEvent caps (256/128/64) should be derived from the schema constants to avoid drift.

## LOW
L1. Provider/event ids: handler `validEvent` allows an `accountId` up to 256 chars but the DB resolve function and event schema accept the same; fine. But `eventId` is limited by CONTROL regex only; Stripe/Intuit ids are fine. No action.

L2. Secret gate runs before signature check (handler.ts step 4 before 7), so an unauthenticated caller can distinguish "provider not configured" (503) from configured (401). Low information (the registry is public in code). Optional: accept.

L3. Sequential per-event awaits (resolve cached per account, then claim, send, mark = 3 round trips per event, up to 200 events). Intuit expects a fast ack (it retries on slow responses); a 200-event batch could take many seconds. Fix in T-053 if needed: bound batch to a smaller `MAX_EVENTS_PER_DELIVERY` per provider or run claims with limited concurrency. Not needed for pilot volume.

L4. `webhook_event_mark` (migration) transitions any `received` row, so a stale attempt that was reclaimed by a second delivery can mark the row `failed` or `enqueued` out of turn. Low impact (a retry re-claims). Optionally compare `attempts`.

L5. Stripe fit: the handler wants one `accountId` per event; platform events have no `account`, so T-058 needs a per-lane/platform account id from config, which `parse(body)` (no deps) cannot read. `parse` has no access to lane_config. Either parse returns `accountId` of "platform"/a sentinel and the store resolves it, or pass a resolver. Decide in T-058; mention in the PR note. Stripe's `t=,v1=` verifier fits the interface (signedAt from `t`), tolerance 300 works, secret `whsec_...` passes the length gate. Multiple secrets (rotation) are not supported by `getSecret(): one SecretValue`; low.

L6. Intuit fit: `hmacSha256Verifier({signatureHeader:"intuit-signature", encoding:"base64"})` with `toleranceSeconds: null` works as claimed; base64 compare is on the exact string (fine). Intuit bodies are batched (`eventNotifications[]`); the shared `payloadHash` per body is fine. Add an Intuit-shaped verifier test vector (known base64 HMAC) in T-053, not here.

L7. `sendLaneEvent` `id` (core/inngest/index.ts): `event.id ?` treats "" as absent; fine. Test in send.test.ts verifies passthrough. Event schema is strict and sound: provider regex should match PROVIDERS (it does); consider `z.enum(PROVIDERS)` instead, but core cannot import connectors; leave.

L8. Registry empty and route factory: fine. `receiveWebhook` is built at module import time and imports `getServerEnv` lazily inside closures (good). The route test mocks only the 404 path; no test proves 200 through the real route wiring (acceptable until a provider exists).

L9. Scope: `WebhookStore.purge`, `webhook_events_purge`, authenticated SELECT on the table, and the pgTAP purge tests are not in T-036 acceptance (T-042 owns retention). They are small, documented in the PR and plan-review. Keep; note for the reviewer. `test-util.ts` and `testing/mock-webhook.ts` are test helpers living in src (check they are not exported from index.ts: they are not).

L10. Duplication: `validEvent` bounds duplicate event-schema bounds and SQL check constraints (three places). See M5.

## Test-quality notes (not vacuous overall)
- Good: forged/tampered/future/old timestamps, uniform 401 body, fail-closed variants (null, short, throws), prototype-name 404, streaming cap, logging canaries, payload-lane-ignored, partial-batch retry. pgTAP covers real claim/mark/resolve/RLS.
- Weak: see M5 (memory store mirrors SQL by hand; schema check missing), M4 (stuck-window only tested in pgTAP). proxy matcher tests build a RegExp from the matcher string, which approximates Next's path-to-regexp; adequate.
