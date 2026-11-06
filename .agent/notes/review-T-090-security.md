Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
No BLOCKER or HIGH findings, so nothing here stops T-090 from being finished. I only read the code: running the tests needed approval this session didn't give, so I haven't confirmed `fin-sync.test.ts` and the other changed tests pass.

**Checklist results**
- **Lane scoping:** good. Each lane is checked only through `enabledLanes()`. `qboSyncIntervalHours` reads lane_config with a lane filter, using a client from the lane router. The connection list reuses the existing lane-filtered query. `conn.sync` checks the event and the lane again when it arrives (`conn-sync.ts:44-46`).
- **Logging:** no tokens, prompts or document/email bodies are involved. Failed lanes are recorded by lane id only, with no error text, and there's a test for that.
- **External writes:** none. The backup poll only reads from QuickBooks (CDC is QuickBooks' change-data-capture feed) through the existing connector.
- **Input checks:** the new `finance.qbo_sync.interval_hours` setting is Zod-checked: only 1, 2, 3, 4, 6, 8 or 12 hours, no extra keys, default 4. A bad value fails that lane for that tick instead of falling back to a default, and the code checks the value again before using it.
- **No new tables**, so no RLS or pgTAP work is needed.

**MEDIUM**
1. **`packages/core/src/inngest/fin-normalize.ts:196-199` — a failed normalize step now waits up to about 24 hours to be retried.** Before, if starting the normalizer failed (`followUp: "failed"`), the next sync of any kind tried again. Now a scheduled poll that wrote nothing skips it, except between 00:00 and 03:59 UTC. Example: a webhook sync writes records, starting the normalizer fails, and the next 4-hourly polls find nothing new. Those records stay out of `fin.*` until the next 00:00 UTC poll. If that poll is skipped as `already_running` or fails, the wait is another day. The same applies to picking up a mapping change.
   - The rule also checks the clock when the sync finishes, not the scheduled hour. A 00:00 UTC poll held up by retries or queueing past 04:00 loses its catch-up.
   - **Fix:** normalize when this connection's last sync run recorded `followUp: "failed"` or has no normalize after it. Or pass the scheduled hour through the event and decide on that instead of `new Date()`. Add a test for "a failed follow-up and then empty polls still normalizes."

**LOW**
2. **`fin-sync.ts:312` — the list of allowed intervals is written out twice.** `FIN_SYNC_INTERVALS` copies `QBO_SYNC_INTERVAL_HOURS` from `packages/core/src/lane-config/index.ts:241`. Both are in `packages/core`, so if one changes and the other doesn't, valid lanes fail every tick. **Fix:** import `QBO_SYNC_INTERVAL_HOURS` from `../lane-config`.
3. **`fin-sync.ts:331` — `finSyncEventId` doesn't check that `connectionId` is a UUID.** `finNormalizeEventId` does. `planFinSync` already filters ids, so this is only a defence if someone calls it directly. **Fix:** add the same `UUID.test` check and throw.
4. **`route.ts:55` — the normalize rule decides by UTC hour, everything else by lane.** **Fix:** none needed now. If it stays, note in the doc comment that the catch-up window is the 00:00 UTC poll, which always runs whatever the interval, because every allowed interval divides 24.
5. **`.agent/notes/review-T-090-security.md` and `review-T-090-code.md` contain no review.** Each holds only a Claude Code warning that the workspace isn't trusted, so they don't count as the review the definition of done asks for. **Fix:** save this review and the code review into them before writing the PR body.

**Not issues, checked**
- Using `step.sendEvent` instead of `sendLaneEvent` is safe: it's documented, the lanes come only from `enabledLanes()`, and `conn.sync` checks again on arrival.
- A failed lane stops that run without retrying, and only after the healthy lanes have been sent.
- Event ids are fixed per connection and hour, so a repeated tick doesn't sync twice.
- `reconnect_required` connections are left out by the shared connection list, and `conn.sync` checks again (QB-12).
- Calendar schedule runs also use trigger `"schedule"`, but the normalize hook only acts on QuickBooks.
