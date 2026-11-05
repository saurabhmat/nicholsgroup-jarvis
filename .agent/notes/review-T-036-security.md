# T-036 security review (commit b67e25c, webhook receiver framework)

Reviewer: security-reviewer subagent, Nov 4, 2026. Read-only; no db reset or e2e run.
Result: **no BLOCKER, no HIGH.** 2 MEDIUM, 7 LOW.

## Verified (no finding)
- Order (handler.ts:74-130): method, registry (regex + Object.hasOwn), jobs, secret, content type, capped raw read,
  verify on the exact bytes, tolerance, then parse. Nothing is looked up, written or queued before verification succeeds.
  getSecret is the only provider call before verification, and it is synchronous.
- safeEqual (crypto.ts:8-12) hashes both sides before timingSafeEqual, so neither length nor content leaks through timing.
  Hex is compared lower-case. A throwing verifier is treated as a refusal. Every refusal returns the same 401 body.
- Fail closed: a null, empty, throwing or under-16-character secret gives 503 before any I/O (handler.ts:86-94).
  Preview or no Inngest gives 503 (index.ts:25).
- Body (body.ts): Content-Length is checked against the cap first, the stream is cut at the cap, and the hard maximum is 4 MiB.
- Lane comes from server data only. store.resolve asks each enabled lane through getLaneJobClient. The SQL predicate is the
  same as the connections_one_lane_per_account index (provider, lower(), status not in disconnected/pending, lane enabled).
  An account found in two lanes is treated as unknown. A laneId in the payload is ignored (handler.test.ts:267).
  sendLaneEvent checks ENABLED_LANES and uses a strict schema with ids only.
- Definer functions: all have search_path = '', are revoked from public/anon/authenticated, grant execute to service_role
  only, and are listed in the 050 catalog. claim checks that the connection is in the lane, belongs to the provider, is
  usable and that the lane is enabled. mark and purge filter on lane_id, and the pgTAP test shows an APK mark or purge does
  not touch PKG rows. The purge floor cannot be bypassed with mixed-sign intervals ('1 mon -40 days' is under 7 days).
- Claim races: INSERT ... ON CONFLICT DO NOTHING followed by a guarded UPDATE. Under READ COMMITTED, a concurrent second
  updater re-checks the WHERE clause against the committed row (now 'received' and recent), so it cannot also get 'process'.
- Table: there is no payload column. The service_role table grants are revoked. authenticated has a column-level SELECT
  that excludes payload_hash, so the hash also cannot be used in WHERE or in PostgREST filters (42501). pgTAP checks the
  hidden column, cross-lane denial, finance_operator, aal1 and anon.
- Proxy (proxy.ts:66): the excluded prefix is anchored at the start of the path. Next and Vercel normalize `..` and `%2e%2e`
  (WHATWG URL) before both matching and routing, so the matcher and the router see the same path. `%2F` is not a separator.
  /api/* already returned before the lane check (proxy.ts:32), so the exclusion only skips refreshSession and cannot skip a
  lane 404. The only route under app/api/webhooks is [provider]/route.ts, and a bad key returns 404 from the regex.
- Logging: provider, lane, connection, event_id, an outcome enum, a regex-bounded request id and counts. No secret,
  signature, body, account id or getSecret error text is logged.
- Rules 2, 4, 5, 6, 9 and 10 hold: no company-specific code, no external writes, ids only in Inngest, synthetic fixtures.

## MEDIUM
**M1: an in-flight 'received' row answers 200 'duplicate', so the provider stops retrying and the event can be lost.**
migration 20261104140000_webhook_events.sql:141-154, handler.ts:150-153.
Scenario: delivery A claims the event and then dies (function timeout or crash), or both enqueue and mark('failed') fail
(handler.ts:171 swallows the mark error). The row stays 'received'. The provider retries within 2 minutes, or a concurrent
duplicate delivery arrives while A is in flight and A then fails. The claim returns 'duplicate' (or 'conflict'), the route
answers 200, and the provider marks the event delivered. Nothing is queued and no sweeper picks up the stuck row. The data
self-heals only through the next scheduled sync.
Fix: have claim return a distinct 'in_flight' when the existing row is 'received', not stale and not yet enqueued. The
handler should answer 503 with Retry-After for that result, and 200 only for 'enqueued' duplicates. Alternatively, add a
T-042 sweep that re-sends 'received' rows older than 2 minutes, using the same Inngest id. Add a Vitest test and a pgTAP test.

**M2: a tolerance is not enforced when a verifier returns signedAt but the provider sets toleranceSeconds: null.**
handler.ts:115-120, hmac.ts:29-35.
Scenario: a later provider configures hmacSha256Verifier({ timestampHeader }) but leaves toleranceSeconds: null. Captured
signed requests can then be replayed after the 30-day purge, as new events (the job is only a trigger, so the impact is
limited to extra syncs). Fix: when verdict.signedAt is non-null, always apply a tolerance (default 300 s). Alternatively,
assert at registration that timestampHeader implies a numeric toleranceSeconds, and test it.

## LOW
- L1 (handler.ts:84): if jobsAvailable() throws (getServerEnv parse error), the handler throws an unhandled error and Next
  answers 500. This is still closed, but it bypasses refuse() and its log line. Wrap it in try and refuse with 503.
- L2 (handler.ts:136-187): an unknown account returns after one resolve round trip, while an accepted event also does
  claim, enqueue and mark. Timing therefore separates unknown accounts from accepted events, but only for a sender who holds
  the app-level signing secret, which is the provider. No fix needed; recorded so the "learns nothing" claim is not overstated.
- L3 (store.ts:53-66): resolve fans out with Promise.all over every enabled lane, so one lane's database outage gives 503 for
  every lane's webhooks. This fails closed, but lanes depend on each other for availability. With more lanes, consider a
  per-lane timeout, and answer 503 only when the failing lane could own the account.
- L4 (store.ts:21, rule 1): WebhookStore.resolve takes no laneId. This is by design, because it discovers the lane, and each
  RPC it makes carries one. Document it as the single allowed exception, or rename it resolveLaneForAccount so the rule-1
  lint and review know it is intentional.
- L5 (body.ts:22-41): there is no read deadline, so a slow body can hold a function until Vercel's max duration. Also no
  rate limit (already logged). Fix: an AbortSignal.timeout around the read, for example 10 s, and Vercel firewall rules.
- L6 (migration:191-207): purge accepts any p_lane from service_role, with no check that the lane exists or is enabled.
  This is within the service_role trust boundary in a shared database. Acceptable. T-042 should pass only router lanes.
- L7 (proxy.ts:66): any future route placed under app/api/webhooks/ silently skips session refresh. Add a test that the only
  route file under app/api/webhooks is [provider]/route.ts, and state in a comment that nothing session-based may live there.
  No pgTAP or Vitest test covers concurrent claims. Consider a two-session claim test if the harness allows it.
