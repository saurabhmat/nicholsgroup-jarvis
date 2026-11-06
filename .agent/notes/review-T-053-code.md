Review of T-053 (QuickBooks webhooks, QB-11). I read the diff and the code paths. I did not run typecheck, lint or tests.

**BLOCKER**
- None found.

**HIGH**
- None found.

**MEDIUM**
1. `packages/connectors/src/sync/runners.ts:35`: the stale-cursor fallback is incomplete.
   - The targeted-run guard only checks `stored !== null`.
   - `quickbooks/sync.ts` ("targeted && since === null") also throws `invalid_input` when the stored cursor is unusable, meaning older than 30 days minus 1 hour or in the future.
   - A webhook for a long-idle connection therefore fails instead of falling back to a full sync, which is what the comment above that line promises.
   - Fix: drop `objectTypes` in the runner when the cursor is unusable, or make `sync.ts` fall back to a full load for a targeted run.
   - Add a runner test for the no-cursor and stale-cursor cases. `runners.ts` has no test change in this diff.
2. `packages/connectors/src/sync/index.ts:21-29`: `isQuickbooksConnectionUsable` catches every error and returns `false`.
   - A transient DB or lane-router failure is treated as "not usable". The webhook change is then dropped silently (`not_usable`, no retry).
   - The receiver has already claimed the event in `core.webhook_events`, so Intuit's redelivery is deduped. The change is lost until the next scheduled full sync.
   - Fix: return `false` only for "not found" or "wrong status" and let infrastructure errors throw, so the `step.run` and `retries: 3` apply.
   - Add a test for that distinction.
3. `packages/connectors/src/webhooks/quickbooks.ts:61-67`: a missing or unparseable `lastUpdated`/`time` becomes `at = ""`.
   - Every later update to the same entity, id and operation then gets the same dedupe key and is dropped permanently.
   - Legacy payloads always carry the timestamp. CloudEvents `time` is optional and unverified (H-037).
   - Fix: when no timestamp is present, don't dedupe on it. For example, add the delivery or body hash to the key, or at least log the case and add a test.

**LOW**
1. `packages/core/src/inngest/qbo-webhook-sync.ts:47-48`: `batchEvents.key` uses only `connectionId`. Groups are keyed `lane:connection`. This is harmless because connection ids are UUIDs, but `lane:connection` would match the grouping.
2. `qbo-webhook-sync.ts` has no test for `step.run` and `sendEvent` replay behaviour or a retried `isUsable` throw. Those belong with fix 2.
3. `apps/web/app/api/inngest/route.ts:42`: the `laneId as LaneId` cast skips validation. `enabledLanes()` is checked first, so the risk is small. A `laneIdSchema.parse` would be cleaner.
4. `packages/connectors/src/sync/index.ts:38`: `QBO_SYNC_ENTITIES` is exported from the `sync` barrel but defined in `../quickbooks/entities`. This is a layering oddity, and it keeps core from importing connectors directly. Fine as is; optionally re-export it from a connectors index instead.
5. Process, not code: the diff leaves `.agent/notes/.t053-*.err` and `checkpoint-2026-11-02-b.md` untracked, and `.agent/pr/T-053.md` is absent from the file list. Definition of done requires the PR body there. The `.err` files should not be committed.
6. `docs/backlog.md` already has T-053 set to `status: done`. That's correct on merge, but fix items 1 and 2 first.

**Checked and fine**
- Rules 1, 4, 5, 9 and 10 hold:
  - Lane comes from the DB, not the payload.
  - The webhook only enqueues ids and entity names.
  - The sync goes through conn.sync and the connector.
  - The token is read through its own required env shape and fails closed with a 503.
- Spoofed, replayed and duplicate payloads are tested. The reconnect_required skip and cross-lane grouping are tested.
- No new dependencies. Changes outside the task are limited to the `objectTypes` plumbing, which the task needs.
