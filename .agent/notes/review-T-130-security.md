Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
I found **no BLOCKER or HIGH issues** in T-130, so nothing here stops the task from finishing. There are 2 MEDIUM and 6 LOW findings. I didn't run `pnpm typecheck`, `lint` or `test`. I only read the code, so the fixes below are suggestions.

**Rule checks:**
- **Lane routing:** `targets.ts:31` gets its client from the lane router (`getLaneJobClient`) and filters with an explicit `.eq("lane_id", laneId)` (`targets.ts:35`). That filter matters because the job client bypasses RLS. The test covers it (`targets.test.ts:22`). The fan-out carries `laneId` on every event, and conn.sync re-checks the lane and connection status when it runs.
- **RLS:** no SQL or table changes, so no RLS or pgTAP work is needed. The service-role client is used only on the server.
- **Secrets:** no tokens, record content or database error text leave the code. Lane-list errors become a generic `ConnectorError`, and `failedLanes` holds lane ids only (tested in `cal-ingest.test.ts`).
- **External writes:** none. This is a read-only list plus sends of Inngest events that are internal to the app.
- **Validation:** the event is a strict Zod object and `trigger` is now required. Forged or malformed events (missing trigger, unknown trigger, extra fields, bad uuid or lane) are refused before any sync runs.
- **Retrieved content, AI tools, webhooks, stored bodies:** none of these are touched by this change.

## MEDIUM

**M1. The scheduled function's body has no tests** (`packages/core/src/inngest/cal-ingest.ts:63-79`)
- The tests cover the config, `planCalIngest`, the event ids and conn.sync's refusals.
- Nothing runs the handler itself: getting the tick number from `event.ts`, falling back to `Date.now()`, sending nothing when the plan is empty, the event list passed to `step.sendEvent`, or failing the run only *after* healthy lanes were sent.
- CLAUDE.md requires tests for new behaviour.
- **Fix:** pull the handler out as `handleCalIngest(deps, eventTs, step)` (the same pattern as `handleConnSync`), or use `@inngest/test`. Test with a fake `step` that:
  - checks the exact events (`trigger: "schedule"`, ids `cal-ingest:<id>:<tick>`);
  - checks there is no `sendEvent` call when there's nothing to send;
  - checks that with one lane failing, `sendEvent` is called for the healthy lanes *and then* `NonRetriableError` is thrown;
  - checks the return value `{ lanes, connections, slot }`.

**M2. The new "skip" setting is asserted but its consequences aren't** (`packages/core/src/inngest/conn-sync.ts:34,59`)
- The test only checks that `singleton: {key, mode:"skip"}` is set. It doesn't check that it is compatible with the `concurrency` setting on the same key.
- It also changes behaviour for every trigger, not just the schedule. A `webhook`, `manual` or `connect` request that arrives while a scheduled sync is running, or waiting between retries for up to 15 minutes, is now dropped silently. Changes after that sync's delta fetch can lag by up to about 15 minutes.
- **Fix:**
  1. Confirm on the Inngest dev server (inngest 4.26.2) that the function registers with both `singleton` and `concurrency`.
  2. Record the webhook/manual skip trade-off in `.agent/notes/T-130.md` and the PR's risk list.
  3. If an immediate manual sync must be guaranteed, consider applying the skip only to scheduled events.

## LOW

- **L1.** `cal-ingest.ts:65`: if `event.ts` is missing, the tick comes from `Date.now()`, so a function retry could compute a different tick and a different event id. In practice `step.sendEvent` remembers what it already sent, so the risk is small. **Fix:** compute the tick inside a `step.run("slot", …)`, or throw `NonRetriableError` when `event.ts` is missing.
- **L2.** `events.ts:15`: making `trigger` required means any `conn/sync.requested` event already queued without a trigger will now fail permanently. This only matters for local or dev queues (pilot), but it's worth a line in the PR's risk list.
- **L3.** `targets.ts:41`: hitting `MAX_SYNC_TARGETS` (200) cuts the list off silently, and some connections would never be scheduled. **Fix:** fetch `limit + 1` and log a warning (lane id and count only) when it overflows.
- **L4.** `cal-ingest.ts:68-74`: the fan-out uses `step.sendEvent` rather than `sendLaneEvent`, so it skips the send-side validation and "lane served" check. conn.sync re-validates both and the plan only covers enabled lanes, so this is safe. **Fix:** add a one-line comment saying the bypass is deliberate, so a later change doesn't drop the `enabledLanes` filter.
- **L5.** `targets.ts:9`: `CALENDAR_PROVIDERS` is hard-coded. That's fine under rule 2 because it describes a provider's ability, not a company setting. Keep it out of `lane_config`, but make sure the Microsoft calendar task updates it (add a backlog note).
- **L6.** `.agent/notes/review-T-130-security.md` looked empty when I read it. **Fix:** write this review into it so the PR body (`.agent/pr/T-130.md`) can list these findings, as the definition of done requires.

I couldn't save this as a plan file because no write tool is available in this read-only session.
