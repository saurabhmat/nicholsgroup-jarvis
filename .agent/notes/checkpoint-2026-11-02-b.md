# Checkpoint — Nov 2, 2026 (evening)

Branch `agent/pilot-build` in `~/dev/pubk-projects/jarvis/pilot-build`, HEAD 5fa4a86. Supersedes `checkpoint-2026-11-02.md` ("Next" section).

## Housekeeping done
- Worktree renamed T-005 -> pilot-build. `.env.local` copied from `jarvis/main` (git-ignored). Checkpoint-note path edits committed (d344375).
- Memory copied to the pilot-build project memory dir. Old dir renamed `~/.claude/projects/UNUSED-jarvis-main-old-memory`.
- `jarvis/main` is the primary checkout (holds the shared `.git`; do not delete or move). Its HEAD is detached (was stale `agent/T-007`, contained in pilot-build). `nicholsgroup-jarvis` renamed `~/dev/pubk-projects/UNUSED-nicholsgroup-jarvis`; it holds a `.env.local.save` (credentials, never opened) — delete when sure.
- Left alone on purpose: `~/.claude/projects/` dirs for jarvis-T-005, jarvis, nicholsgroup-jarvis.

## Tasks
- **T-035 done** (c89ebf4). Deferred: security M1 (one provider account per lane or shared; needs a product decision, best with T-050).
- **T-039 done** (b7c50df, 173484c, 3d839ee, 02f8d64, 5fa4a86). Four rounds of independent security + code review; no BLOCKER; every HIGH fixed. PR body `.agent/pr/T-039.md`, review notes `.agent/notes/review-T-039-*.md`.
  - Known gaps (logged in `docs/plan-review.md`): key-name guards are a backstop only — each adapter needs a strict allowlist projection per provider/object_type (incl. dropping QBO `CustomField` / GHL `customFields` name/value arrays); glued names (`EMPLOYEESSN`), cross-script look-alikes, substring false positives (caffeine/itinerary/sewage); bodies persist after a lane flips `store_content_bodies` off (register `raw.source_records` in T-042 purge).
  - Open decisions for Saurabh: do monday `column_values` and Notion titles count as content; migration timestamp `20261102080000` may need renumbering against other SQL tracks.
- All checks green on 5fa4a86 (typecheck, lint, test 196 pass, test:db 12 files, db:types:check).

## Pushed
`git push` is blocked for agents by `.claude/hooks/guard-bash.sh`. Saurabh pushed `agent/pilot-build` (5fa4a86) and confirmed the Vercel Preview deployed after the fix below. PRs are opened in the web UI (gh not authed).

## Waiting on Saurabh
- **Vercel Preview build failure — resolved** (Saurabh confirmed it deployed). Cause was `EnvValidationError` on INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY. By design: `packages/core/src/env/schema.ts:158` refuses Inngest keys on a PR Preview (T-037 review M2). Fix: remove both from the Vercel **Preview** environment, leave Production alone, redeploy. If it still fails check `APP_ENV=preview`.
- **D-20 close-out:** prototypes were shared earlier but are not in the repo (`docs/design/` does not exist). Provide the canvas URL + version (I record it in the D-20 entry) or drop an export in `docs/design/`; plus final tokens (provisional ones are in `docs/plan-review.md` §7). Then check D-20 off and approve T-023, T-024, T-026, T-025, T-045 – T-047.
- Earlier items still open: Inngest local dev-server check (finishes T-037), Sentry DSN H-011 (T-041), Playwright browser libs (T-018 – T-020), D-8 from Sophie by Nov 13, H-023 (by Nov 12), H-012.

## Next (no human needed)
T-038 (conn.sync skeleton; needs T-037 done), T-040, T-042, T-036, T-003 (ready), QuickBooks tasks once H-005 is in. Run `node scripts/next-task.mjs --explain` first.
