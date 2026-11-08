# Checkpoint: Nov 8, 2026 (before Saurabh's night test)

Branch `agent/T-219` (HEAD 4291079 at the time of writing), stacked on agent/T-216 and agent/T-212. Saurabh reports pushed, merged and redeployed. Nothing below was verified live: the first live test is tonight, with Saurabh present.

## Production state (set up today by Saurabh in the Supabase SQL Editor, project lxjhaxdkqtmkhloqaffb)
- 32 migrations recorded (a repair, `repair-4b.sql`, fixed three unapplied part-4 migrations and five unrecorded part-5 ones).
- part-6-T-219.sql (migrations 20261108120000 and 20261108130000) and `production-pkg-lane-config.sql` were run (Saurabh confirmed). The first run created PKG lane_config v1: modules assistant/comms/calendar/brain, mailbox saurabh@pub-k.org, mail_transport native.
- `manual-migrations/*.sql` are git-ignored on purpose (generated copies); only the folder's .gitignore is committed (bdc8105). `production-pkg.sql` and `production-pkg-lane-config.sql` are committed.
- Supabase Data API exposes `core` and `audit`. Sign-in works (email OTP set to 6 digits, owner membership in PKG).
- Google OAuth redirect `https://nicholsgroup-jarvis-git-main-saurabhmats-projects.vercel.app/api/connect/google/callback` is set in Google and Vercel (`GOOGLE_REDIRECT_URI`).

## Built today (all reviewed, 0 BLOCKER / 0 HIGH after fixes)
- **T-212** prompt assembly with brain blocks (1965ac1). No SQL.
- **T-216** chat-first setup interview + Settings -> AI brain fallback (bada09b). Deterministic engine, no model; Save only on click; test briefing waits for T-213 (`TEST_BRIEFING_AVAILABLE = false`). iPhone Playwright spec written, NOT run (its setup resets the local DB).
- **T-219** Composio connect + Settings (8c257b8, review fixes 609debe). Built on MSW fakes only; real Composio never called; COMPOSIO_API_KEY never read by agents.
- T-213 and T-216 approved by Saurabh Nov 8; T-219/T-224 approved. T-224 not built.

## Tonight's test (runbook: docs/runbooks/first-test-nov8.md)
Native Google connect -> wait for first sync -> Assistant "set up my brain" -> Save a group -> ask the assistant. Needs Vercel vars ANTHROPIC_API_KEY, ANTHROPIC_MODEL_ANALYSIS, ANTHROPIC_MODEL_FAST, GOOGLE_*.
Unknown until tested: whether the mail/calendar sync starts by itself after connecting (H-032/H-033 live checks never ran); whether assistant env vars are set in Vercel.

## Waiting on Saurabh (Composio, H-039/H-041)
Zero Data Retention on; Gmail + Calendar auth config ids (`COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID`); throwaway Gmail for the D-35 spike; run `pnpm test:bundle` once with apps/web/.env.local moved aside. The Composio key was pasted in chat once: advised to rotate it.

## Next (after the night test; fix what it finds first)
1. T-224 Composio read tools (approved; on fakes).
2. Settings shows only the lane's `mail_transport` section (Google or Composio), small follow-up.
3. T-213 needs T-162 and the Approval Center chain (T-104, T-110-T-113, T-123, T-133); not started.
4. Open review items logged in docs/plan-review.md (T-212, T-216, T-219 follow-ups): passive Composio health check before PKG switches; pin Composio consent host; Test route rate limit.

## Known display bug (not fixed)
Dark theme: the "Jarvis" wordmark, the company switcher and the selected Home item are dark blue on dark blue and hard to read.

## Tooling notes
node is not on PATH: `. ~/.nvm/nvm.sh && nvm use 24`. `node scripts/test-db.mjs --no-reset` runs pgTAP without wiping local connections. Agents cannot `git push` (guard hook).
