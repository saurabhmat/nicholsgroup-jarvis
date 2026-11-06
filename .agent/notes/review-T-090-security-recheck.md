Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
All five T-090 fixes are in place, and I found no BLOCKER, HIGH or MEDIUM issues. I only read the code; I didn't run typecheck, lint or tests.

**The five fixes**
1. **`shouldNormalizeAfterSync` no longer reads the clock** (`fin-normalize.ts:208-210`). It now looks only at the trigger, the run kind and the number of records written. It skips normalizing only when a scheduled incremental poll wrote nothing. This fixes the MEDIUM in both reviews about the hour-<4 window and the 03:59/04:00 boundary.
2. **Daily normalize at 00:00 UTC** (`fin-sync.ts:392-397`). The hourly tick sends `fin/qbo-normalize.requested` with trigger `schedule` for each connection when `hour % 24 === 0`. That hour comes from the scheduled time, not the clock, and every allowed interval divides 24, so every lane is due then. The event id is `finNormalizeEventId(conn, "daily-<day>")`, which passes the `RUN_ID` check, so a replay doesn't double-send. `"schedule"` is added to the trigger enum (`events.ts:176`). The normalize function checks the lane again on arrival (`fin-normalize.ts:56`) and doesn't branch on trigger. No SQL constraint restricts the trigger value. Tests cover the 00:00 tick sending both batches and the 04:00 tick sending only the sync batch. This fixes the "failed follow-up stuck for up to a day" MEDIUM.
3. **`qboSyncIntervalHours` reads only `finance.qbo_sync`** (`lane-config.ts:131-141`). It parses that section with the shared `qboSyncSchema`, and `laneConfigSchema` uses the same schema. A `finance` value that isn't an object still fails closed. A test shows that a malformed `payroll` or `reports` section no longer blocks the poll.
4. **`FIN_SYNC_INTERVALS` is now imported** from `QBO_SYNC_INTERVAL_HOURS` (`fin-sync.ts:314,330`), so the list is defined once. The `as unknown` cast is replaced by explicit `z.literal` values.
5. **`finSyncEventId` now validates its inputs** (`fin-sync.ts:349-352`): the connection id must be a UUID and the hour a non-negative safe integer. Tests are added.

**Security checklist:** clean.
- Lanes come only from `enabledLanes()` and are checked again when the event arrives.
- Events carry ids only.
- Failed lanes are recorded by lane id, with no error text.
- No new tables, external writes, tokens or document/email bodies.
- The new config value is checked with Zod.

**LOW (no action required)**
- **`route.ts:34-35`:** the comment says "the next sync retries" a failed normalize. That's no longer always true for empty scheduled polls; the 00:00 UTC daily normalize covers them now. Update the wording.
- **`fin-sync.ts:392`:** if a lane fails planning on the 00:00 UTC tick, that lane gets no catch-up normalize that day; the next one is 24h later. The run fails visibly in Inngest, so this is acceptable. Mention it in the PR body.
- **`fin-sync.ts:392`:** the daily normalize is sent in the same tick as the 00:00 poll, so it may run before that poll finishes. If the poll writes anything, its own normalize follows anyway, so this is harmless.
- **Still open from earlier reviews:**
  - The PR body (`.agent/pr/T-090.md`) and the backlog `status: done` are still missing.
  - The `.agent/notes/*` review files are now filled in, but they still start with the "workspace not trusted" warning line.

T-090 is clear to finish once the PR body and backlog status are added.
