I found no BLOCKER, HIGH or MEDIUM issues in the four fixes. There is one new LOW, and it does not block finishing T-053. I read the code and existing tests only; I did not run typecheck, lint or tests.

**1. `packages/connectors/src/sync/runners.ts` (fallback to a full run): fixes the earlier MEDIUM #1.**
- **Safe for QuickBooks:** both places that refuse a targeted run happen before any Intuit call, audit row, token use or write to the sink (`quickbooks/sync.ts:80` and `:132`). The only thing that runs earlier is the lane-scoped payroll-setting read (`deps.payroll(laneId)`). So the full re-run cannot double-count `received` or write anything twice. `assertLaneBound` still runs first, and the full run gets the same lane and connection. `job.test.ts:84` covers the fallback.
- **New LOW: the fallback is in the shared runner, not the QuickBooks one.** `runners.ts:42-44`
  - Problem: the shared runner retries any `invalid_input` from a targeted run as a full run. If a later connector throws `invalid_input` after it has already sent records to the sink, those records are processed twice and `received` is counted twice. The full run still only reads, so this is not a security problem.
  - Smaller effect: the "Unknown QuickBooks object type" refusal at `sync.ts:80` also turns into a full run instead of failing. It can't be reached today because webhook entity names are checked against `QBO_SYNC_ENTITIES` first.
  - Fix: have the connector mark the refusal as safe to retry before any I/O, for example with a separate kind or a `retryAsFull: true` flag on the error. Alternatively, fall back only when `received === 0`.

**2. `packages/connectors/src/sync/usable.ts`: OK.**
- A `not_found` answer means the connection is missing or belongs to another lane, and returns `false`, so nothing reveals which. Any other error is rethrown inside `step.run`, so Inngest retries it, up to 3 times.
- The check runs through the lane-scoped loader.

**3. `packages/connectors/src/webhooks/quickbooks.ts:87-89, 128`: fixes the earlier MEDIUM #2.**
- When there is no usable time, the key uses `nots:<sha256(body)>`. A later change to the same record therefore gets a new event id, and a retry of the identical body still dedupes. An identical body can only be replayed with the valid Intuit signature.
- The hash is taken over the already-verified raw body. Only a truncated hash leaves the parser, never the body itself.
- Side effect, not a finding: two different deliveries that both lack `time` and name the same change produce two events. That costs at most one extra read-only CDC (changes-since) call.

**4. `packages/core/src/inngest/qbo-webhook-sync.ts:210, 224-226, 264, 270`: fixes the earlier LOW #5.**
- The batch key, the `usable:` and `sync:` step ids and the event id now all include `laneId`. The grouping key was already `laneId:connectionId`.
- `qbo-webhook-sync.test.ts:26-27` checks that the batch key includes the lane.

The earlier LOW #4 is still open and outside this re-check: the function runs for every `webhook/received` event, so it needs an `if: provider == 'quickbooks'` filter on the trigger.
