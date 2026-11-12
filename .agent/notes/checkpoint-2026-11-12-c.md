# Checkpoint — Nov 12, 2026 (c): T-236 AI output limit done

Checkout `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-236`** (from `agent/T-235`). Not pushed (agents can't push). The previous checkpoint is `checkpoint-2026-11-12-b.md` (T-235).

## Push / merge order
Each branch contains the one before it. Push and merge them in this order, with merge commits:
1. `agent/T-232`
2. `agent/T-192`
3. `agent/T-234`
4. `agent/T-235`
5. **`agent/T-236`**. PR body: `.agent/pr/T-236.md`.

## What T-236 fixes
In production, "News could not be fetched: the AI answer could not be used" and the briefing failures were caused by `stopReason: max_tokens`. Current models always think, and thinking counts toward the limit; the limits were 4000 (news) and 3000 (briefing).
- **The limit:** `news.max_tokens` and `briefing.max_tokens` in lane_config, default 8000.
- **A cut-off reply** is never parsed. It gets one retry at 1.5x the limit and effort "low" with a smaller request (news: at most 4 stories); a second cut-off is the fixed code `output_truncated`.
- **News:** at most 6 stories and a "why" of at most 200 characters. Validation is forgiving: stories are dropped one by one with reason codes, and the fetch fails only with none left.
- **Logs** carry codes and counts only.
- **The hourly Refresh slot:** a failed fetch never uses it (SQL as before: a retry is allowed 5 minutes after a failure; pgTAP 305).
- **The contract test** against the real API: `pnpm --filter @nichols/web test:ai-contract` with `AI_CONTRACT=1` (H-054).

## Commits
| Step | Commit |
|---|---|
| Build | `50a4519`, `fe623e5` (script) |
| Review fixes (effort low on retry, one-attempt reserve, scheduled abort, context-window stop, tests) | `829256f` |
| Docs, LOW fixes, backlog done, this note | the commit that adds this note |

Reviews: a security review, a code review and a security re-check of the fixes. No BLOCKER or HIGH is open; the code-review HIGH (retry timing) is mitigated and documented. LOW items are in `docs/plan-review.md` under "T-236: logged, not fixed".

## Test results
- `pnpm typecheck` and `pnpm lint`: 18/18.
- `pnpm test`: 18/18 plus 216 root script tests (web 910 passed, 3 skipped: the opt-in contract tests).
- No SQL changed, so neither `pnpm test:db` nor e2e was required. The e2e suite was not re-run (no UI change beyond a new failure text).

## Production SQL
**None for T-236.**
- `brief.news_digests.failure_code` accepts any `^[a-z][a-z0-9_]{0,39}$`.
- Briefing failure notes accept `^fail:[a-z_]{1,40}$`.
- The new lane_config keys have defaults in code.

Parts 1–13 from earlier checkpoints are unchanged; part 13 (T-235) is still needed before deploying T-235/T-236.

Optional, only if production logs show replies near the limit: raise a lane's limit with a new lane_config version through the usual human step (`news.max_tokens` / `briefing.max_tokens`, 2000..32000).

## Needs human (`docs/backlog.md`)
- **H-054 (new):** run the contract test once with the production model. It covers H-052 too; about $0.30–$1, synthetic inputs only, nothing stored. No live call was made during the build.
- Still open: H-053 (the background run's time on Vercel; now also the retry's), H-046, H-002, H-045, H-047, H-048 and H-049–H-051.

## Decisions taken (logged; change them if you disagree)
- **One undated story** per digest is still kept as "date unknown" (T-234 decision). Setting `NEWS_MAX_UNDATED` to 0 drops all undated stories.
- **The news reserve covers one attempt, not the retry.** The cap can be passed once per lane per month, by about $1.17 at default prices.
- **The retry is best effort** inside the existing 60 s and 70 s bounds. If it times out in production, raise `maxDuration` (a Vercel plan decision) or move the runs to Inngest.

## Next
Run `node scripts/next-task.mjs --explain`.
