Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
## T-040 review: security and code (read-only)

**Verdict: no BLOCKER or HIGH findings.** On the security side the change is ready. Four MEDIUM findings (M1 and M2 are behaviour bugs, M3 and M4 harden the attention event) and four LOW ones should be logged in `docs/plan-review.md` or fixed now. I did not run `pnpm typecheck/lint/test`.

### Checklist
- **`laneId` everywhere:** pass. All three new events require `laneIdSchema` (`events.ts:46-71`) and are added to `LANE_EVENTS`. The workers check the payload again and check the lane against `ENABLED_LANES` (`conn-health.ts:72-76`). Every database call goes through `getLaneJobClient` from the lane router (`vault/index.ts:42`) and filters on `lane_id` in the query as well (`store.ts:16, 32-35`; the loader too).
- **RLS / service-role key:** no SQL and no new table. Nothing new reaches the client or `NEXT_PUBLIC_*`. Core still does not import connectors.
- **Tokens and secrets:** pass. The logs carry only `laneId`, `provider`, `connectionId`, `kind` and `disposition`. The error text built in `failureError` contains only the error kind. `last_error` stores `ConnectorError.toJSON()`, which is redacted, the same as the existing T-196 pattern. Tokens stay inside the QuickBooks token manager, which handles concurrent refreshes safely.
- **AI tools / retrieved content:** not applicable.
- **External writes (rule 5):** pass for now. The health check only reads CompanyInfo. The list of renewers is empty, so no provider-side writes happen. The rule 5 question is logged in `plan-review.md`.
- **Webhooks / Zod:** no new webhook. The Inngest route was already signed (T-037). Both worker events are strict Zod objects and are checked again inside the worker.
- **Forbidden data:** none is stored. Only health fields on `core.connections` change.

### MEDIUM
**M1. A good health check clears errors that other jobs wrote.** `packages/connectors/src/health/job.ts:74-82`
- When a connection is `degraded`, a passing check sets `{status: "active", last_error: null}`.
- That wipes errors this check never tested, such as a subscription-renewal failure (`job.ts:135`) or, later, a T-195/T-196 failure.
- **Fix:** only heal when the stored `last_error` came from this check. Either give health errors their own marker, or heal only when `last_error.endpoint`/`kind` matches what the health check produces. Add a test where a renewal failure survives a good health check.

**M2. The job ignores the "row changed" result from `applyHealth`.** `job.ts:78` and `job.ts:92`
- When the status guard finds the row has changed and returns `false`, the job still reports success, and on the failure path it still sends `health_check_failed`.
- The alert itself is acceptable, but nothing records that the write was skipped.
- **Fix:** log a warning such as `conn.token_health.superseded`. Optionally return `skipped: "row_changed"`.

**M3. Attention events are sent without being checked against their schema.** `conn-health.ts:101-117` (fan-out at 122-131 and 139-147 has the same gap)
- In inngest 4.26, `eventType.create()` returns an `UnvalidatedCreatedEvent`, and `step.sendEvent` bypasses `sendLaneEvent`.
- So the "ids and enums only, never a message" rule on `conn/attention.needed` is never enforced when the event is sent.
- Today the payload is built from typed fields, so the real risk is low. But the guarantee the comments promise is not real.
- **Fix:** run `connAttentionNeeded.schema["~standard"].validate(data)` (or the `validated()` helper) on each payload before `step.sendEvent`. Drop any alert that fails, log only its kind, and add a test.

**M4. An out-of-range `daysLeft` or an unexpected provider name can break the run after the database write.** `job.ts:38` and `events.ts:63-66`
- If `token_expires_at` is more than 10 years in the past, `daysLeft` falls below the schema minimum of -3650.
- A provider name that fails `^[a-z][a-z0-9_]{1,31}$` has the same effect.
- Once M3 is fixed, either case throws after `applyHealth` has already written, which causes retries and a failed run.
- **Fix:** clamp `daysLeft` to ±3650 in `expiryAlert`, and handle an invalid provider explicitly.

### LOW
- **L1.** `conn-health.ts:141`: the renewal stamp `now().toISOString().slice(0,13)` is computed outside a step. If a run is retried across an hour boundary, the fan-out gets new ids and does not dedupe. **Fix:** compute `d` and `stamp` inside `step.run("plan")` and return them with the plan.
- **L2.** `health/index.ts:11-13`: the empty renewers list is the only thing enforcing rule 5. **Fix:** add a test that fails if a renewer is registered without the rule 5 decision, e.g. assert `subscriptionRenewJob.providers()` equals `[]` and point to the `plan-review.md` entry.
- **L3.** `store.ts:21-23`: a lane-client failure becomes `connection_unavailable`, which is not retried. This matches the loader, so it is only noted. The scan already skips a failed lane, so the impact is small.
- **L4.** The concurrency key is `event.data.connectionId` without the lane. That is fine because connection ids are UUIDs. For the multi-lane habit, consider `event.data.laneId + ":" + event.data.connectionId`.

### Already logged correctly in `docs/plan-review.md`
- `conn/attention.needed` has no consumer, because the backlog's "T-181" reference is out of date.
- `reconnect_required` is left to T-195.
- Renewal against rule 5 is still undecided.
- Google, Stripe and GoHighLevel have no health checker yet.

These still need a human. Also, `.agent/notes/review-T-040-security.md` and `review-T-040-code.md` are only 295 bytes each, which looks like placeholders. Replace them with this report before the PR.
