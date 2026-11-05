Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
Review of T-040 is done. I found no BLOCKER or HIGH issues. The 28 connector tests and 35 core inngest tests pass. I didn't run typecheck, lint or the full suite.

## BLOCKER
None.

## HIGH
None.

## MEDIUM
1. **Scan can report success when every lane failed to list.** At `packages/core/src/inngest/conn-health.ts:122-131` and `:141-151`, `planFanOut` swallows listing errors and returns `failedLanes`. The cron function then returns normally. If the store is down, every lane fails, no event is sent, and the run shows as green. Nobody learns that token health stopped. Fix: after the fan-out, throw a plain `Error("conn scan: lanes failed")` (no database text) when `failedLanes.length > 0`. That uses the scan's `retries: 1` and shows up in Inngest and Sentry. Alternatively, throw only when all lanes failed. Add a test.
2. **Silent truncation at 500 per lane.** `conn-health.ts:57` (`slice(0, MAX_PER_LANE)`) and `store.ts:30` (`LIST_LIMIT`) cut the list without a trace. Connections past 500 are never checked. Also, a single `step.sendEvent` with more than 512 events could fail once several lanes are enabled. Fix: include a `truncated` flag in the scan's return value, or log it. Chunk the `sendEvent` calls if more lanes are enabled. This is fine for the PKG pilot, so a note in `plan-review` is enough.
3. **A failing health check alerts every day, indefinitely.** The `attn:` event id changes daily and a failed connection stays in the usable set, so it alerts again each day. This may be intended. If the consumer should fire only on a state change, say so in `plan-review`, because the future consumer will need to dedupe or escalate.

## LOW
1. `packages/connectors/src/health/job.ts:65-73`: a passing QuickBooks health check heals `degraded` to `active` and clears `last_error`. That also wipes a degraded state that `conn.sync` set because of a failing sync. Health only proves the CompanyInfo call works. Fix: heal only if `last_error` came from a health failure, or leave healing to sync success. Alternatively, note it in `plan-review`.
2. `job.ts:69,83`: the return value of `applyHealth` (`false` when the row changed) is ignored. The alert is still sent, which is fine. A debug log line on `false` would help.
3. `packages/connectors/src/health/index.ts:12`: the `conn as Parameters<…>[1]` cast bypasses typing. Prefer a narrow type guard on `provider === "quickbooks"`.
4. `conn-health.ts:136-138`: the health check runs outside `step.run`. If the later `sendEvent` step fails and the function retries, the provider call repeats. This is harmless because the check is read-only and the event ids dedupe. Wrapping the check in a step would avoid the repeat.
5. **Test gaps.** None of these has a test:
   - `applyHealth` failing on the failure path of the health job.
   - The scan-level `step.sendEvent` ids (`health:<conn>:<day>`, `renew:<conn>:<hour>`).
   - A health check returning `ok:false` with no `error` field.

   The `plan-review` entry already admits there are no step-level scan tests.
6. The stale T-181 reference is correctly logged in `plan-review`. The backlog acceptance text could be fixed in the same change, but that is the human's call.

## Checked and fine
- **Spec match:** `token_expires_at` is the credential expiry (about 100 days for QuickBooks), not the hourly access token, so the 7-day rule won't fire falsely. The 7-day boundary is tested at 6 and 8 days, and the expired case has a test. Health failures and renewal failures both emit the notification event. There is no SQL change, so no pgTAP is needed.
- **Rules:**
  - Every function, event and store call takes `laneId`.
  - Lane clients come from the lane job client.
  - The health check is read-only.
  - The renewer registry is empty, and the rule-5 question is logged.
  - Events carry ids and enums only, and there are canary tests.
  - There is a cross-lane denial test.
  - No new dependencies.
- **Scope:** the only edits outside the task files are the expected route, `vault/index`, `package.json`, `events` and `index` wiring, plus `plan-review`.
