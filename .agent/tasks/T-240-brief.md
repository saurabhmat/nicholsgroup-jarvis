# T-240 brief: Home top 5 (recency-aware ranking, honest "Waiting on you"), Home polish fold-in

Approved by Saurabh on Nov 13, 2026. His request, verbatim:

> Mail-stall results: no stall. Mail synced every 15 min from Nov 9 to Nov 12 at ~750 records/day (Nov 11 low because of the US holiday). It stopped only during the Vercel 401 (Nov 12 8:45 AM ET until the fix) and caught up with 741 records on Nov 13.
> So the 6-day-old Home items are a ranking problem, not sync. New task T-240 (after T-238 ships):
> - Top 5 ranking: blend recency with importance; new mail from the last 48h that needs a reply should outrank week-old threads; older unanswered threads go to a "Still waiting" line or Inbox, not the top 5 by default.
> - "Waiting on you" chip only when Robert is the last recipient and no reply was sent; otherwise show the reason (Money, Deadline, VIP).
> - Fold in the earlier Home polish items: UTC/internal ids (r4/r6) in the summary text, attendee names (Rnichols, Wcobb), newsletters from our own domains, a greeting by Eastern time of day, sidebar brand clipping, a slim QuickBooks strip, and the "Top 5 · metadata only" label.
> Unit tests with synthetic data. Close the mail-stall item in the T-238 notes.

(The T-238 notes item is already closed by the lead.) Saurabh is away and does not want to be asked. Make the scope decisions yourself and log them in `.agent/notes/T-240.md`. Where an item below is ambiguous, pick the reading that serves an executive glancing at Home, and log it.

## Where you work
- Branch: `agent/T-240`, created from agent/T-238. Check with `git branch --show-current`.
- Do not switch branches. Do not push. Never run `git rebase` or `git reset`.
- `git add` only your own files. Never `-A`. Never commit `.agent/notes/checkpoint-2026-11-02-b.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commit per part (1, 2, 3a–3g), plus one for the PR body and notes.

## LOCAL DATABASE: DO NOT RESET
- `node scripts/test-db.mjs` resets the database on EVERY call without `--no-reset`, including `--help`. It ignores unknown flags. Always pass `--no-reset`. Never run it for any other reason.
- Never run `pnpm test:db`, `supabase db reset`, `pnpm test:e2e`, or any Playwright run (the global setup resets).
- New migrations: `supabase migration up --local --workdir supabase/core`. If the CLI is missing, run `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)"`.
- pgTAP: `node scripts/test-db.mjs --no-reset`. All 51 files pass today; keep it that way.
- If you change SQL, write the gitignored manual pair `supabase/core/bootstrap/manual-migrations/part-19-T-240.sql` and `check-part-19.sql` in the style of part 18 (a guard requiring part 18, version 20261119110000), and run both locally. Prefer no SQL if you can.
- Synthetic data only. No external calls in tests. No mail content or tokens in logs.

## Root cause of the old items (lead's finding)
- `packages/modules/briefing/src/domain/attention.ts`, `rankAttention`: the final sort is `tier`, then `receivedAt` ASCENDING ("within a tier, older first").
- Nothing limits age. An unanswered thread from last week (tier 1, "waiting") always beats new unread mail (tier 2) and sorts before newer threads in its own tier.

## 1. Top 5 ranking
1. Add a freshness window: `lane_config.briefing.attention.fresh_hours`, default 48. Add it to the lane_config schema with bounds (e.g. 6..168) and a test (rule 2: no company values in code).
2. The top 5 holds only threads that qualify today AND whose latest inbound message is within the window. Order by importance, then NEWEST first. Importance bands, high to low:
   - an authenticated priority sender (VIP);
   - Money or Deadline (see part 2);
   - waiting on the owner;
   - unread from a real person;
   - security alert;
   - repeated failures.

   You may implement this as a score that blends a band weight with a recency decay. Either way, the tests must prove that a 2-hour-old unread from a person outranks a 6-day-old "read, not answered" thread.
3. Qualifying threads older than the window are not in the top 5. They feed a "Still waiting" line under the list:
   - Text: "Still waiting: N older threads" (or "1 older thread"), linking to Inbox. Use an existing Inbox filter if one fits; otherwise add `?view=waiting` with a matching Inbox filter, and test it.
   - Hide the line when N = 0.
   - No exception for priority senders: an old VIP thread also goes to Still waiting. Log this decision.
4. `more` keeps its meaning (fresh items beyond 5) and its "View all in Inbox (N)" link.
5. The AI briefing reads the attention list as input (check `apps/web/lib/briefing-run.ts` and related). Feed it the same fresh list, and give the Still waiting count as a number only, so the summary stops leading with week-old mail.
6. Update the header comment of `attention.ts`.
7. Tests, synthetic:
   - boundaries at 48 h;
   - fresh beats old within and across bands;
   - newest first within a band;
   - the Still waiting count;
   - exclusions unchanged (bulk, newsletter and the rest are never top 5);
   - a custom `fresh_hours`.

## 2. "Waiting on you" only when true
1. Show the "Waiting on you" chip (`domain/sender.ts`) ONLY when both hold:
   - the thread's latest message is addressed to the owner, meaning the owner's mailbox address is in its To (not only Cc or Bcc, not a list);
   - no reply from the owner came after it (`lastIsOwner` false).

   "Robert" means the lane owner whose mailbox it is: the connection's mailbox address. Never a hard-coded name or address (rule 2).
2. `core.briefing_threads` probably does not expose To today; `comms.message_index` has `to_recipients`.
   - Add a boolean such as `last_to_owner`, computed in SQL from the latest inbound message's `to_recipients` against the connection's `external_account_id`, case-insensitive.
   - Return the flag only, never the recipient list.
   - pgTAP must cover it, including a cross-lane denial.
3. Otherwise the reason chip shows why the thread is there:
   - **Money:** the existing `money` subject patterns.
   - **Deadline:** a new `lane_config.briefing.deadline_subjects` list. The default is conservative whole words, e.g. "deadline", "due today", "due tomorrow", "by EOD", "RFP", "proposal due", "expires". Log the list.
   - **VIP:** an authenticated priority sender.
   - At most 2 chips, as today.
   - A thread with none of these and not waiting shows "Unread" or nothing, as before.
4. Rename the reason text "Read, not answered" / "Waiting on your reply" where it would contradict the chip. Keep reasons factual.
5. Tests: To vs Cc, an owner reply after the last message, a list address, and each reason chip.

## 3. Home polish
- **a. Summary text.**
  - The AI summary shows internal ids like "r4"/"r6" (the prompt's row refs) and UTC times.
  - Fix it at the source: the prompt must ask for none, and times go in as Eastern.
  - Also add a deterministic post-processor before display or save. It removes bare row refs (`\br\d+\b` in ref positions, `(r4)`, `[r6]`) and rewrites any ISO/UTC timestamp into Eastern "9:42 AM ET" (or drops it).
  - Find where refs are produced (`briefing-run.ts` / the briefing prompt) and keep the internal linking (for example the citations to threads) working.
  - Tests with synthetic summaries.
- **b. Attendee names.**
  - Today's calendar shows handles turned into names ("Rnichols", "Wcobb" from rnichols@ / wcobb@).
  - Never synthesize a name from an address's local part. Use, in this order: the attendee's display name from the event; then a name we already hold for that exact address (e.g. a `from_name` in the lane's mail index, if one is cheaply available via an existing read); else the full email address (or "local part @ domain" shortened with CSS).
  - Keep the T-237 dedupe by name and domain working. Tests.
- **c. Newsletters from our own domains.**
  - Mail from the lane's own domains that is a newsletter must stay out of the top 5 even when the org list `briefing.exclusions.org_newsletter_senders` is empty and the row has no bulk header flag (older rows).
  - "Own domains" means the domains of the lane's configured mailboxes / connections, derived, not hard-coded.
  - Rule: an own-domain sender that is not a person mailbox is excluded as bulk. That covers a no-reply/newsletter/news/updates/info/marketing local part, a List-style label, or `is_generated`.
  - Do not exclude a real colleague writing from the same domain. Tests: a colleague still ranks, a newsletter address is excluded.
- **d. Greeting by Eastern time of day.**
  - "Good morning" before 12:00, "Good afternoon" 12:00–16:59, "Good evening" from 17:00, all America/New_York, whatever the viewer's zone.
  - Find it in `components/home-page.tsx`.
  - Test the boundaries, including a DST date.
- **e. Sidebar brand clipping.**
  - The brand/logo text in the sidebar is clipped. Find the sidebar component, fix it (no truncation at the default width; the collapsed state still works), and check light and dark.
  - Add a component test that asserts the classes/structure, since there is no visual test here.
- **f. Slim QuickBooks strip.**
  - Replace the full-size "Connect QuickBooks" tile on Home (T-237: the KPI row shows one tile when QuickBooks is not connected) with a slim one-line strip: "QuickBooks is not connected. Connect it to see cash, AR and bills." It links to Settings → Connections, with the Connect action for owner/admin_technical only.
  - When QuickBooks is connected but in `reconnect_required`, the strip says so instead.
  - The KPI row shows only connected sources (as T-235).
  - Keep it accessible. Tests.
- **g. The "Top 5 · metadata only" label** (`home-page.tsx`, PageSection note).
  - "metadata only" is internal jargon: remove it.
  - The note becomes "Top 5 from the last 48 hours", using the configured `fresh_hours`, worded naturally ("last 2 days" if you prefer). Log it.
  - Check that no other user-facing text says "metadata only".

## Done
- `pnpm typecheck && pnpm lint && pnpm test` pass. pgTAP `--no-reset` passes (all files).
- Do not add or run Playwright. If an existing e2e spec asserts text you changed ("Top 5 · metadata only", the greeting, the QuickBooks tile), update the spec so it typechecks and lints, and list it in the PR as not run.
- Write `.agent/pr/T-240.md`: changes, tests, risks, production SQL part 19 if any, and Needs human. The Needs human list must include a production look at Home after deploy (are the top 5 fresh? does Still waiting show the old threads?).
- Write `.agent/notes/T-240.md` with the decisions.
- Do NOT set the backlog to done.
- Final message:
  - a summary;
  - the commit list;
  - test results (typecheck, lint, test, pgTAP);
  - the decisions you made;
  - anything unfinished.
