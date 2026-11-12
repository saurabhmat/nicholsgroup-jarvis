# Checkpoint: Nov 11, 2026 (night, b)

For whoever picks up T-234 in the morning (Saurabh or the next agent). Checkout `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-234`**, not pushed. Agents can't push, so Saurabh pushes. The previous checkpoint is `checkpoint-2026-11-11.md` (commit `8ecf816`: T-231a-d, T-232, T-233).

## Branches and push/merge order
1. `agent/T-232` (ends `8ecf816`), as in the previous checkpoint.
2. **`agent/T-192`** from `agent/T-232`, ending at `cbb66a4`. **Done.**
3. **`agent/T-234`** from `agent/T-192` (`cbb66a4`). Parts 0 and 1 are done and reviewed; part 2 is committed but not yet reviewed; parts 3 to 5 have not started.

Push and merge in that order. Each branch contains the one before it.

## T-192 `action.reconcile_stuck`: done (needed before H-047)
- **Commits:**
  - `ffeeb42`: the build.
  - `6a57788`: review fix and PR body.
  - `cd97d4c`: fixes from the first review round.
  - `c478ab5`: the pre-send duplicate check is scoped. It searches only `in:sent` / `in:drafts`, and From must be the sending mailbox and the SENT/DRAFT label present. The execute path and the reconciler share this check.
  - `cbb66a4`: a parser-based From check, and tests of the label check against a raw search.
- **What the job does:** it runs every 5 minutes. It picks up actions stuck in `executing` for longer than `lane_config.approvals.reconcile_after_minutes` (10 by default) and checks them read-only. The possible results are:
  - verified;
  - failed, with the code `verification_mismatch`, `ambiguous_match`, `reconcile_payload_changed` or `reconcile_sent_unverified`;
  - failed with `outcome_unknown`, once `reconcile_give_up_minutes` (60 by default) has passed. A message not being found never counts as "not sent".
- **What it never does:** it never re-sends and never creates a second claim. A forged inbound copy, in the Inbox or in Spam, can't block or fake a send.
- **Reviews:** two security rounds and one code round. No BLOCKER or HIGH is open.
- **Logged in `docs/plan-review.md`:** the cap of 20 actions per lane per run, and that the body is kept for up to 60 minutes when nothing is found. Saurabh accepted both. Also logged: a copy moved to Trash, or a draft the user edited, ends as `outcome_unknown`.
- **Tests:** typecheck, lint and the 18 unit-test tasks pass; `test:db` passes 2508.
- **PR body:** `.agent/pr/T-192.md`.

## T-234 Home v2: in progress
The brief, verbatim: `.agent/tasks/T-234-brief.md`. Running log: `.agent/notes/T-234.md`. Backlog entry: `status: approved`.

| Part | Commits | State |
|---|---|---|
| 0: env hardening and Run now | `09255a8`, `3206321`, `9868356` | Done; security and code reviewed, plus a security re-check. No BLOCKER or HIGH open. |
| 1: layout | `ca17c30`, `78f5af4` | Done; security and code reviewed. Full typecheck, lint and test pass at `78f5af4`. |
| 2: Needs your attention | `bd7e524` | Committed and passing (typecheck, lint, 18/18 test tasks, test:db 42 files). **Not reviewed yet.** |
| 3: reply drawer | | Not started |
| 4: GovCon news | | Not started |
| 5: auto-refresh without losing work | | Not started |

**Part 0:**
- The env schema trims every value in one place.
- `ANTHROPIC_MODEL_*` must match `^claude-[a-z0-9-]+$`. The error names the variable and never prints the value.
- Briefing failures show a fixed reason code. The admin hint is built on the server and shown only to owner and admin_technical.
- Run now runs inline and has a time limit (75 s). After the cutoff an AbortSignal blocks every write, a late job proposal is withdrawn through the new `act.withdraw_proposed`, and only one run can be in flight per lane and owner. Run now had never actually depended on Inngest.

**Part 1:**
- Home is a grid: attention (2/3) next to the calendar with Next 7 days collapsed; a strip of 5 KPI tiles; news (2/3) next to projects.
- Coverage moved to Settings → Connections. The Home header shows a dot that reads "Sync issue" or "Status unknown".
- KPI tiles show their caveats ("Excludes N unmapped accounts", "Net, <month>"). Roles without finance access see no finance tiles.
- MRR and Paid subscribers show "Not connected", because nothing reads Stripe or GoHighLevel yet.

**Process note:** commit `9868356` (part 0 fixes) also contains part 1's deletion of `home-finance.tsx` and its test. Two builders were running in the same tree at the time, and that commit doesn't typecheck on its own. Every commit from `ca17c30` on is green. From now on, run one builder at a time.

### Part 2 (`bd7e524`), not reviewed yet
- **Open link bug, cause and fix:**
  - The sync stored `mail/u/<address>/#all/<id>`. Gmail's `/u/` takes an account index, not an address, so Google opened the wrong page.
  - Home now opens `/<lane>/inbox/<messageId>`, the existing T-202 thread view.
  - "Open in Gmail" is built as `?authuser=<mailbox>#all/<hex thread id>` (`packages/connectors/src/comms/gmail-url.ts`).
- **Exclusions:**
  - One `classify` function (`packages/modules/briefing/src/domain/attention.ts`) applies to Home, the money list and the AI input.
  - `lane_config.briefing.exclusions` holds `org_newsletter_senders` (empty), `calendar_subjects`, `auto_reply_subjects` and `bot_subjects`.
  - New boolean columns on `comms.message_index`: `is_bulk`, `is_calendar` and `is_auto`. They are worked out from headers at sync time; no headers or bodies are stored.
- **Decision to review:** priority senders now skip every exclusion except OTP, calendar and auto-reply.
- **Known limit:** Gmail metadata doesn't list nested MIME parts. A `text/calendar` part is therefore caught only through the Calendar `Sender` header, the `Content-Class` header or the subject prefixes.
- **Card:**
  - The AI summary shows 2 lines, with "More from the briefing" for the rest.
  - Below it: the prepared time, Run now and the top 3.
  - The top 5 items each have Reply and Open.
  - Drafts and deadlines are folded into a collapsed section.
  - `components/reply-action.tsx` is the hook part 3 replaces with the drawer.
- **The `mail.test.ts` rate-limit test** failed once under load. It passed 5 of 5 alone and in the full run, and part 2 adds no reads, so it's logged as a flake in the T-234 notes.

## Production SQL (Saurabh runs it by hand in the SQL Editor, in this order)
All files are in `supabase/core/bootstrap/manual-migrations/`. Git ignores this folder, so the files exist only in this checkout.
1. Parts 1 to 10 and their check files, as in earlier checkpoints.
2. **`part-11-T-192.sql`**, then **`check-part-11.sql`**: all 9 rows should be true, and one extra query is informational. It refuses to run unless `20261111200000` (part 10) is recorded. **Required before H-047, live sending.**
3. **`part-12-T-234.sql`**, then **`check-part-12.sql`**: every row should be true. **Not final.** Later parts keep adding to it. So far it has:
   - `20261113100000` briefing_failure_reason
   - `20261113110000` approvals_withdraw_proposed
   - `20261113120000` message_flags_and_thread_ref (part 2; ran against the local DB, every check row true)

   It refuses to run unless `20261112100000` (part 11) is recorded. Don't run it until T-234 is finished.

## Needs human
- **H-047** (live sending): its steps are unchanged, and step 6 now refers to part 11.
- **H-048 (new, doesn't block):** PKG's own newsletter sender addresses go into `briefing.exclusions.org_newsletter_senders` in the lane config editor. Optionally, run one full Gmail resync after production part 12, so the last 90 days get their flags.

## Next (morning)
1. Part 2 (`bd7e524`): run the security and code reviews, then fix every BLOCKER and HIGH (and the worthwhile MEDIUMs). Also review the hand-edited `packages/core/src/db/types.ts`; regenerating it is safer.
2. Parts 3, 4 and 5, one builder at a time, each followed by both reviews.
   - Part 4 must check that news URLs are https before putting them in an `href` (logged in plan-review).
   - Part 4 adds the `web` category to `llm_allowed_categories`, plus a per-lane monthly spend cap, with migration, pgTAP and part 12.
3. `pnpm e2e:brain`. Resetting the local DB is approved. It needs the Node 24 PATH: `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | tail -1)"`.
4. Final checkpoint with the full part-12 SQL and checks, set T-234 to done, and `.agent/pr/T-234.md`.
