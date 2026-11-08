# Checkpoint — Nov 8, 2026

Branch `agent/brain` in `~/dev/pubk-projects/jarvis/pilot-build`. Not pushed (agents cannot push). Supersedes the Nov 7 checkpoint.
Tooling: `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`. Never reset the local DB. New migrations: `supabase migration up --local --workdir supabase/core`, then `node scripts/test-db.mjs --no-reset`.

## Done today
- `c75f72d` T-100 review fixes → **T-100 done**.
- `5252004` + `9256654` T-101 tool registry + policy gate → reviews in, MEDIUMs fixed → **T-101 done**.
- `5fd518e` + `d9a3f6e` T-102 untrusted wrapping (fail-closed `trustedFields`), `runToolLoop`, injection suite → 5 HIGH from reviews fixed; real-model suite passes → **T-102 done**.
- `ba30f4a` **T-105/T-106 demo scope** (approved by Saurabh Nov 8): `core.ai_tool_categories`, `list_recent_mail` + `list_meetings` tools, `@nichols/ai/chat`, POST `/api/lanes/:laneId/assistant` (SSE), Assistant page. Live check with the real model OK.
- `a348d09` chat review fixes: sec H1 (`core.ai_chat_turn`: assistant access + turn limit before any model call, migration `20261108110000`), code H1/H2, demo MEDIUMs. Live re-check OK. Tasks stay `approved` (T-103 storage, T-104 finance tools, Playwright still open).
- Local DB: migrations `20261108090000` (edited after first apply, re-applied by hand), `20261108100000` and `20261108110000` applied with `supabase migration up --local`.

## Next
1. Manual browser run of the Assistant page once Saurabh has added the model vars (desktop + iPhone width).
2. Saurabh: add `ANTHROPIC_MODEL_ANALYSIS=claude-sonnet-5-5` and `ANTHROPIC_MODEL_FAST=claude-haiku-5-5` to `.env.local` (key alone = "not set up"). Push `agent/brain`, open PR, check the Vercel Preview (Preview has no real-data secrets).
3. Then T-212, Briefing v1 proposal (Nov 7 checkpoint).

## Demo (Tuesday Nov 10)
Visible: sign-in + MFA, Home, Inbox, Finance (empty states), Approvals, Settings/connections, **Assistant** (mail + calendar Q&A, streaming, source chips linking to Inbox/Calendar, refuses to act). Suggested questions: "What needs my attention today?", "What's on my calendar today?", "Any important email I haven't read?". Calendar and Projects pages are still placeholders. Finance questions get "no tool provides that" (T-104).
