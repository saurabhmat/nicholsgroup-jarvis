I found no BLOCKER or HIGH issues in the T-053 diff, so nothing has to be fixed before the task can finish. There are 3 MEDIUM and 6 LOW findings. The MEDIUMs are reliability and process gaps, not security holes.

I reviewed the uncommitted diff plus the new files, and read the shared receiver (`webhooks/handler.ts`, `hmac.ts`, `store.ts`), the QuickBooks connector sync and the event schemas they depend on.

## Checks that pass
- **Lane scoping:** every new function takes `laneId`. The realm is matched to a lane and connection from server data, never from the payload. The usability check loads the connection through the lane-scoped loader. The follow-up job checks the event schema and the enabled lanes again when an event arrives.
- **Database:** no new tables or SQL, so no new RLS or pgTAP tests are needed. No service-role key or `NEXT_PUBLIC_*` variable is involved.
- **Signature:** HMAC-SHA256 over the raw body, base64, compared in constant time. It fails closed: a missing or empty token, or one under 16 characters, gets a 503. The token is never logged, returned or put in an event, and a test covers the logging.
- **Untrusted data (rule 9):** parsing uses strict, size-capped Zod. Entity names must be in `QBO_SYNC_ENTITIES`, so Employee and TimeActivity are dropped. Ids and realms are pattern-checked. `objectTypes` is checked twice, by the event regex and by the connector's own list. The webhook triggers only a read through the connector.
- **External writes and stored data:** nothing is written to any external system and there are no approvals involved. Only a hash of the body is stored; no body, account number or compensation data is stored.

## MEDIUM
1. **A webhook arriving after a long quiet spell fails the sync and leaves an error on the connection.**
   - Where: `packages/connectors/src/sync/runners.ts:191` together with `packages/connectors/src/quickbooks/sync.ts:131-132`.
   - Problem: the runner sends `objectTypes` whenever any cursor is stored. If that cursor is older than about 30 days, or malformed, the connector throws `invalid_input` ("A targeted QuickBooks sync needs a current cursor"). The run is logged as failed, `core.connections.last_error` is set, and Inngest does not retry. The change waits for the next scheduled run, and in the meantime the connection looks broken.
   - Fix: when the cursor is no longer usable, do a full run instead of a targeted one. Either export `usableCursor` and check it in the runner, or have the connector switch to a full run (which also moves the cursor) when `since === null`. Add a test with a 31-day-old cursor.

2. **A CloudEvents delivery without `time` can lose a later change to the same record.**
   - Where: `packages/connectors/src/webhooks/quickbooks.ts:56-61`, `:68` and `:97`.
   - Problem: when `time` is missing or can't be parsed, the timestamp part of the dedupe key is empty. A second update to the same record then gets the same event id and is skipped as a duplicate or conflict. CloudEvents always carries a unique `id`, but the parser doesn't read it.
   - Fix: parse `id` (`z.string().max(128)`) and add it to the key when `time` is absent, or always. Add a test where two updates without `time` produce two events.

3. **The task is marked done, but the earlier reviews never ran and there is no PR body.**
   - Where: `docs/backlog.md:472`, `.agent/notes/review-T-053-security.md`, `.agent/notes/review-T-053-code.md`, `.agent/notes/.t053-*.err`.
   - Problem: both review files are empty. The `.err` files show the reviewer stopped at "workspace has not been trusted". `.agent/pr/T-053.md` does not exist, which CLAUDE.md's definition of done requires.
   - Fix: write `.agent/pr/T-053.md` (changes, tests, risks, H-037). Use this review as the security review, run the code review too, and delete the empty files and `.err` stubs.

## LOW
4. **Unrelated webhooks will start this job.** `packages/core/src/inngest/qbo-webhook-sync.ts:101` triggers on every `webhook/received`. Once Stripe, Gmail and monday webhooks exist, each of their events starts the QuickBooks job just to be counted as `not_quickbooks`. Fix: add `if: "event.data.provider == 'quickbooks'"` to the trigger.

5. **The lane test assumes something Inngest doesn't guarantee.** `qbo-webhook-sync.ts:28`, `:42`, `:82` and `:88`: the batch key, the step ids (`usable:${connectionId}`, `sync:${connectionId}`) and the sync event id use only the connection id, not the lane. With the same connection id in two lanes (UUIDs make this practically impossible), the step ids would collide and the second sync request would be dropped as a duplicate. So the test "keeps lanes apart" only passes because the test fake doesn't reproduce this. Fix: add `laneId` to the step ids and the event id hash, and key batches on `event.data.laneId + '-' + event.data.connectionId`.

6. **"Last sync" can look fresher than it is.** `packages/connectors/src/sync/job.ts:89-90`: a run that refreshed only some entity types still sets `last_sync_at = now`, so the freshness display would hide that other entities are stale. Fix: skip the `last_sync_at` update for a subset run, or record that the run was partial.

7. **Env stubs can leak if an assertion fails.** `apps/web/tests/webhook-route.test.ts:76-80`: `vi.unstubAllEnvs()` only runs if every assertion passes, so a failure leaks `INTUIT_WEBHOOK_VERIFIER_TOKEN` into later tests. Fix: move the clean-up to `afterEach` or a `try/finally`.

8. **Needless cast.** `apps/web/app/api/inngest/route.ts:39`: `laneId as LaneId` is safe here, because the lane was already checked against the schema and enabled lanes, but the cast isn't needed. Fix: parse it with `laneIdSchema` or have the dependency type take `LaneId` directly.

9. **Note on rule 4 (no change needed).** The verifier token is read from the environment, not the Vault. That matches how `STRIPE_WEBHOOK_SECRET` is handled: it's an app-level signing secret, not an OAuth token. Mention it in the PR body so the reviewer sees it was a deliberate choice.

The live check against the Intuit sandbox (H-037) is still open and needs a human. I did not run the typecheck, lint or test commands.
