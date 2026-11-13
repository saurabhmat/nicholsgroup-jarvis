# T-238 brief: Sync freshness (Gmail delta schedule, Sync now, Reconnect per connection, sync status line, failure alerts, stale-data line)

Approved by Saurabh on Nov 13, 2026. His request, verbatim:

> Root cause of the stale Home found: Vercel Authentication blocked Inngest (401); fixed with a protection bypass secret on the Inngest app URL. Now:
>   - Add mail-ingest-delta: Gmail history sync every 15 min per connected mailbox, like cal-ingest-delta, then trigger a briefing refresh.
>   - Add "Sync now" (owner/admin) on Home and Settings → Connections, and a Reconnect button per Google connection (updates tokens, never creates a second row).
>   - Replace "Sync issue" with "Mail synced X ago · Calendar synced X ago" (Eastern) and show the real error if a sync failed.
>   - Alert admins when any scheduled function fails 3 times in a row.
>   - If data is older than 24h, the summary says so in one line.
>   Unit tests with synthetic data. No production changes.

He is away and does not want to be asked. Make scope decisions yourself and log them in `.agent/notes/T-238.md`.

Read these first:
- CLAUDE.md
- `docs/backlog.md`: the T-238 entry
- the code named below

## Where you work
- Branch: `agent/T-238`, created from agent/T-197. Check with `git branch --show-current`.
- Do not switch branches. Do not push.
- `git add` only your own files. Never `-A`. Never commit `.agent/notes/checkpoint-2026-11-02-b.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit per part (A–F), plus one for the PR body and notes.

## LOCAL DATABASE: DO NOT RESET
The local Supabase stack holds Saurabh's live connections.
- Never run `pnpm test:db`, `supabase db reset`, `pnpm test:e2e`, or any Playwright run. Playwright's global setup resets the DB.
- Apply new migrations with `supabase migration up --local --workdir supabase/core`.
- Run pgTAP with `node scripts/test-db.mjs --no-reset`. Files 060, 070, 150, 160, 200 and 280 fail only because of live data; every other file must pass.
- If the Supabase CLI is missing: `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)"`.
- Production SQL goes in a gitignored manual-migration pair, `supabase/core/bootstrap/manual-migrations/part-18-T-238.sql` and `check-part-18.sql`, in the style of part 17. It must be schema-qualified and in one script. Run both locally.
- No external calls in tests. No real credentials. Synthetic data only. Never log tokens or mail content.

## What exists today (check it yourself)
- `packages/core/src/inngest/cal-ingest.ts` (`cal-ingest-delta`, cron every 15 min).
  - It sends `conn/sync.requested` (trigger `schedule`, event id `cal-ingest:<connectionId>:<slot>`) for each usable calendar-capable connection.
  - conn.sync (`conn-sync.ts`, wired in `apps/web/app/api/inngest/route.ts`) runs mail THEN calendar for a Google connection. So today the mail delta already rides on the calendar tick.
  - The Gmail delta itself (historyId, full resync on 404) is in `packages/connectors/src/google/mail-sync.ts` / `mail.ts`.
- Briefing:
  - The automatic summary is gated by the SQL run claim, `core.briefing_run_state` / the claim RPC (stale after 3 h, 6 runs a day per lane, one running), from T-235. See `apps/web/lib/briefing-runs.ts`, `briefing-run.ts` and `app/[laneId]/briefing-actions.ts`.
  - The scheduled path is `packages/core/src/inngest/briefing-daily.ts`.
  - `.agent/notes/T-235.md` describes a possible `briefing/auto.requested` Inngest path. Check whether it exists.
- Home sync status: `apps/web/components/coverage-dot.tsx` and `apps/web/lib/coverage.ts` (`core.briefing_coverage`, reason codes with fixed texts in `@nichols/briefing/domain` coverage).
- Settings → Connections: `components/settings-page.tsx`, `components/google-connection-section.tsx`, and the T-197 QuickBooks section as the pattern for role gating, AAL2, the confirm/focus style and `lib/support.ts`.
- OAuth:
  - `packages/connectors/src/oauth/flow.ts` (`ensureConnection(lane, provider, externalAccountId, user)`: the same account already reuses its row) and `state.ts` (signed state).
  - Routes `app/api/connect/[provider]/start|callback`.
- Admin alerts:
  - `conn/attention.needed` events exist (`core/src/inngest/events.ts`, `conn-health.ts`) but have NO consumer.
  - There is no app email sender for alerts. Resend is used only by Supabase Auth.
- Route security pattern: T-196's export route (`app/api/lanes/[laneId]/connector-errors/export/route.ts` with `lib/connector-error-export.ts`): owner or admin_technical at AAL2, 403 for other roles, 404 for other lanes, `Sec-Fetch-Site` cross-site refused, audit row.

## What to build

### A. `mail-ingest-delta`
1. A new Inngest cron function `mail-ingest-delta`, every 15 minutes, modelled on cal-ingest:
   - plan per enabled lane; a lane that cannot be listed is skipped and recorded, never blocking the others;
   - a deterministic event id `mail-ingest:<connectionId>:<slot>`;
   - ids only in events;
   - fan out one `conn/sync.requested` per usable mail-capable Google connection, meaning each connected mailbox.
2. **No double work.**
   - Add an optional `streams` field (`["mail"]`, `["calendar"]`) to `conn/sync.requested` and the runner. mail-ingest asks for mail, cal-ingest asks for calendar.
   - No `streams` keeps today's behaviour (both) for manual, connect and webhook triggers.
   - Update the cal-ingest header comment that says there is no split.
   - Keep conn.sync's concurrency of 1 per connection.
   - You may offset the mail cron (for example `7-59/15`) so the two ticks do not queue behind each other; log the choice.
3. **Briefing refresh.**
   - Trigger: after a scheduled mail sync that wrote at least 1 message. Use conn.sync's `afterSync` hook, or the equivalent.
   - What it sends: `briefing/refresh.requested` with `{ laneId }`, and an event id per lane per 15-minute slot so one tick sends at most one.
   - A new function handles that event. For each owner who holds the briefing view, it runs the briefing through the EXISTING run claim, so the 3 h staleness, the 6-a-day cap and the one-running rule still apply. It must never bypass the cap and never call the AI when the claim says no.
   - Reuse the briefing-daily deps wiring where you can.
   - Choose the trigger value recorded on the run. Use `schedule` unless adding a value is trivial and safe; log the choice.
   - Its failure never fails the sync.
4. Tests (core and connectors):
   - the slot and event id;
   - lane isolation;
   - only mail-capable usable connections;
   - streams honoured, with mail-only never touching the calendar and the reverse;
   - refresh sent only when written > 0 and only for mail;
   - the refresh respects the claim's refusal;
   - one refresh per lane per slot.

### B. "Sync now" (owner and admin_technical)
1. A server route (or server action) for the lane:
   - owner or admin_technical at AAL2;
   - 403 for other roles, 404 for other lanes;
   - cross-site `Sec-Fetch-Site` refused.
2. It sends `conn/sync.requested` with trigger `manual` (both streams) for each usable Google connection of the lane.
3. Rate limit, server side: at most one Sync now per lane per 2 minutes. A deterministic event id per connection per 2-minute slot is fine if it really dedupes. Otherwise use a DB check; log the choice.
4. Audit who, lane and the number of connections, if an audit helper exists for this kind of action. Use ids only.
5. Buttons:
   - On Home, beside the new sync status line (part D).
   - In the Google section on Settings → Connections.
   - Hidden for other roles.
   - After a click, show "Sync started"; on refusal or rate limit, show fixed text. Refresh the status shortly after.
   - Keep it accessible: a real button, a focus state, a live region for the result.
6. Tests: the role, lane and AAL2 matrix; cross-site refused; the rate limit; no Google connection.

### C. Reconnect per Google connection
1. Each Google connection row on Settings → Connections gets its own "Reconnect" button.
   - Show it at least when the row is `reconnect_required` or `disconnected`. Decide whether to show it on healthy rows too and log the decision.
   - The single section-level "Reconnect Google" button goes away in favour of the per-row ones. "Connect another Google account" stays.
2. Binding:
   - The start route accepts the connection id.
   - It binds it into the signed state and may pass the account's email as `login_hint` only if the email is already stored.
   - On callback, the account Google returns must be that row's external account. If so, its Vault tokens are replaced, its status goes back to active, and NO second row is created.
   - If a different Google account comes back, refuse with fixed text. No row, no token stored.
3. Check what `ensureConnection` and the Vault write do today. Keep both QuickBooks and Google working.
4. Tests:
   - same account: tokens replaced, still one row, status active;
   - after `reconnect_required` and after `disconnected`;
   - a different account is refused and nothing is written;
   - a tampered or foreign-lane connection id is refused;
   - role gating.

### D. Home sync status line
1. Replace the "Sync issue" dot and text with `Mail synced 4 min ago · Calendar synced 12 min ago`.
   - Use the oldest last-good sync among the lane's mailboxes and calendars, so it is never optimistic.
   - The title and the accessible name carry the Eastern clock time, for example "Mail last synced 9:42 AM ET".
   - Relative ages follow the existing `ago` helper.
2. When a stream's latest sync failed, show that stream's real error, as the fixed plain-English text for its error code: for example `Mail sync failed: Google access expired. Reconnect in Settings.`, linking to Settings → Connections.
   - Never provider text.
   - Add codes or texts where they are missing.
   - With several mailboxes, say how many failed.
3. Keep:
   - "Status unknown" when coverage cannot be read;
   - nothing drawn when no source is connected;
   - not colour alone;
   - the compact phone form (no sideways scroll).
4. Update the Home tests that expect "Sync issue".
5. Settings → Connections Coverage may show the same per-source error text.

### E. Alert admins when a scheduled function fails 3 times in a row
1. **What counts:** every cron-triggered function in `app/api/inngest/route.ts`, plus conn.sync runs started by the schedule.
   - For a cron, a run that still failed after its retries counts once. Use Inngest's `onFailure`, or the `inngest/function.failed` system event; check the installed SDK.
   - A run that succeeds resets the count.
   - Key the count per (lane, function id, connection id or '').
   - A cross-lane cron records against every enabled lane it serves.
2. **Storage:** a new table with `lane_id`, RLS and pgTAP (cross-lane denial) in the same change. Reads go to the lane's owner and admin_technical only; writes go through the service role / a security-definer RPC. Store only:
   - function id, connection id;
   - consecutive_failures, last_failure_at, last_error_code (a short code, never a message with content), last_success_at, alerted_at.
   Add it to the retention registry or make the rows self-bounding; log the choice.
3. **Alert:**
   - On reaching 3, once per streak:
     - a server log line, error level, ids and code only;
     - an in-app banner for owner and admin_technical on Home and Settings → Connections. Example: "Mail sync has failed 3 times in a row since 9:15 AM ET." Include Contact support (`lib/support.ts`) and a link to Settings.
   - The banner clears after the next success.
   - Give each function id a friendly name.
4. **Email or push:** no alert sender exists, and rule 5 limits external writes. Do NOT add one.
   - Add a Needs human decision item: which channel (email via Resend with an API key, or push).
   - Log it.
5. **Tests:** the counting, the reset, alert once per streak, lane isolation, the banner role gating, and that no content reaches a row.

### F. Stale-data line in the summary
- When the lane's mail or calendar data is older than 24 hours, the Home summary card shows ONE plain line naming what is stale. Example: "Mail was last synced 26 hours ago, so this summary may miss newer email." Here "older" means the oldest last-good sync among connected sources of that kind, or never synced.
- When both are stale, use one combined line.
- Make it deterministic from coverage, not AI text.
- If the summary itself is older than 24 h, the same single line says so instead of adding a second line. Decide the wording and log it.
- Tests: the boundaries at 24 h, mail only, calendar only, both, never synced, and fresh (no line).

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass.
- pgTAP `--no-reset` passes for the new file(s) after `migration up`.
- Manual migration part 18 and its check are written and run locally.
- If you add a Playwright spec, make sure it typechecks and lints; do not run it.
- Write `.agent/pr/T-238.md`. It covers changes, tests, risks, production SQL part 18, and Needs human items:
  - sync the new Inngest functions in Inngest Cloud after the deploy;
  - the alert-channel decision;
  - a live check of Sync now and Reconnect against a real Google account;
  - the Playwright run if added.
- Write `.agent/notes/T-238.md` with the decisions.
- Do NOT set the backlog to done.
- Final message: a summary, the commit list, test results and the decisions you made.
