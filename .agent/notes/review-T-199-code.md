# T-199 code review (uncommitted diff, agent/T-199)

Verdict: no BLOCKER, no HIGH. Core logic matches the acceptance text. Mailbox match is the same lower-case compare as
packages/connectors/src/google/guard.ts. Status values match the DB check constraint. 14:00Z on Nov 5, 2026 is 9:00 EST (DST ended Nov 1), so the e2e time strings are right.

## MEDIUM
1. apps/web/tests/google-connection.test.ts:10-27 - the fake client ignores every `eq`/`in` argument, so nothing proves the
   queries filter by `lane_id`, `provider = 'google'` or `stream in (mail, calendar)`. Fix: record `eq`/`in` calls and
   assert `("lane_id","PKG")`, `("provider","google")`, `("stream",["mail","calendar"])`, and the lane id on the cursor and config reads.
2. Multiple connections and partial per-stream times are not tested (the review brief calls these out). Fix: add a case
   with two connections (different ids) where cursors are per connection, and one with only a `mail` cursor, expecting
   `lastCalendarSyncAt: null` and no cross-connection leakage.
3. Acceptance says "other lanes 404 (tests)" and "server routes/actions return 403". The notes say no new route, so the
   403 lives in the T-035 start route, but nothing in this diff references or tests it for Google, and no test shows the
   other-lane 404 on /<lane>/settings. Fix: add an e2e or unit assertion (lane the user is not in -> 404, as `loadLane`
   does) and a start-route 403 check for provider=google with a non-connect role (or point to the existing connector
   test by name in the PR body).
4. apps/web/e2e/settings-google.spec.ts:139,184-190 - `beforeEach` deletes all Google connections, so the "role that may
   not connect" test never has a connection present. It cannot show that the mailbox, status and sync times are hidden
   from other roles. Fix: seed the connection in that test and assert the mailbox text is absent as well as the
   buttons.
5. google-connection.ts:100-107 plus settings-page.tsx:15 - a database outage in the Google read now throws and takes down
   the whole Settings page, including the T-198 section. Failing closed is right for "not connected", but one section
   shouldn't block the page. Fix: render an inline "Google status unavailable, try again" state (catch in
   `googleSectionFor`, return `{ error: true }`) or wrap the section in an error boundary.
6. google-connection.ts:78-79 and notes "Limits" - "last sync" is the cursor write time, so a healthy sync that finds nothing
   new shows an old time and looks stalled. If `connections.last_sync_at` or `sync_runs.finished_at` is readable by
   these roles, prefer a per-stream finished time; otherwise label it "Last new mail/events received" or log the
   limitation in docs/plan-review.md so H-032 does not read it as a bug.

## LOW
7. google-connection-section.tsx:122-123 - the timezone format (ET label, "not synced yet") is only covered by e2e. Add a
   unit test for `when` covering a winter date (EST) and a summer date (EDT) (export it or move it to the lib).
   The label is hard-coded "ET", which is fine for both.
8. google-connection-section.tsx:168 - nested ternary; use `variant={connected && !needsReconnect ? "outline" : "default"}`.
9. google-connection-section.tsx:168-169 - with several connections and one needing reconnect, the single "Reconnect Google"
   button doesn't say which account. Add the mailbox to the banner text (list the mailboxes that need reconnecting).
10. google-connection.ts:68-76 - a hand-written 3-level `in()` type to bypass the missing generated types. Cleaner fix:
    regenerate the DB types so `sync_cursors` exists (it is a T-063 omission), then drop the cast. If out of scope, keep
    the cast but reduce it to `type Loose = { from(t: string): any }` with a comment.
11. settings-page.tsx:1 - the header comment line is far over the line width; and `await guards()` is called twice (lines 14-15). Reuse one `const g = await guards()`.
12. e2e/settings-google.spec.ts:186 - the persona choice `member === "owner@example.test" ? secondMember : member` is
    convoluted and depends on the project. Use the persona that is known to be a non-connect role directly.
13. apps/web/scripts/e2e-sql.mjs - hard-coded container name and `docker exec`. Fine for local only; add a guard that
    refuses to run unless the container name matches the local project, and note it in the PR body. It is a small piece
    of new test infrastructure, acceptable in scope.

## Checked, fine
- Status mapping (active/pending/degraded/reconnect_required; disconnected hidden) and the DB check list agree.
- Output type has only mailbox, state, allowed flag and two times; `cursor_value` is never selected (tested).
- Only owner/admin_technical via `CONNECT_ROLES`; every AuthError gives null; no external call or write.
- Wording: read-only mail/calendar/Drive, not a sign-in, removal instructions, no Disconnect button (e2e).
- No scope creep in product code; `key={c.mailbox}` is safe because the DB makes (lane, provider, account) unique.
