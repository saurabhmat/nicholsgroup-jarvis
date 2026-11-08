# Checkpoint — Nov 8, 2026

Branch `agent/brain` in `~/dev/pubk-projects/jarvis/pilot-build`. Not pushed (agents cannot push). Supersedes the Nov 7 checkpoint.
Tooling: `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH`. Never reset the local DB. New migrations: `supabase migration up --local --workdir supabase/core`, then `node scripts/test-db.mjs --no-reset`.

## Done today
- `c75f72d` T-100 review fixes → **T-100 done**.
- `5252004` + `9256654` T-101 tool registry + policy gate (`core.ai_tool_gate`, `@nichols/ai/tools`) → reviews in (`.agent/notes/review-T-101-*.md`, no BLOCKER/HIGH), MEDIUMs fixed → **T-101 done**. Deferred items listed in `.agent/pr/T-101.md` (import-graph write scan before T-104; `gate.availableTools` for T-105/T-106).
- `5fd518e` T-102 untrusted wrapping + `runToolLoop` + injection suite (`pnpm test:injection`) — **review running** (security + code). Backlog still `approved`; set `done` after fixing BLOCKER/HIGH.
- Note: migration `20261108090000_ai_tool_gate.sql` was edited after first local apply and re-applied by hand (drop + re-run); a fresh `db reset` gives the same result.

## Next
1. T-102 review findings → fix → done.
2. T-212 (prompt assembly), then the Briefing v1 proposal (Nov 7 checkpoint) awaiting Saurabh's three decisions.
3. H-002 (Anthropic key) still needed for any live AI call; the assistant page in the app is still a placeholder (T-105/T-106 not approved).

## Demo (Tuesday Nov 10)
The AI work so far is backend only (no UI). Visible today: sign-in + MFA, Home, Inbox, Finance, Approvals, Settings/connections. Assistant, Calendar, Projects pages are placeholders.
