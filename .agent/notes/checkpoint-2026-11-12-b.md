# Checkpoint — Nov 12, 2026 (b): T-235 Home polish done

Checkout `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-235`**. Not pushed (agents can't push). The previous checkpoint is `checkpoint-2026-11-12.md` (T-234).

## Push / merge order
Each branch contains the one before it. Push and merge them in this order, with merge commits:
1. `agent/T-232`
2. `agent/T-192`
3. `agent/T-234`
4. **`agent/T-235`**, which ends at the commit that adds this note. PR body: `.agent/pr/T-235.md`.

## T-235 commits (after `agent/T-234`)
| Step | Commits |
|---|---|
| Brief, backlog entry, screenshot spec | `265b921` |
| Synthetic fixture + "before" shots | `4e43cef` |
| 1: automatic AI summary | `c3d50c6`; review fixes `76700b0`; re-check fixes `daf5c2c` (every claim counts toward the 6/day cap; schedule retries) |
| 3–4: compact calendar, KPI only when connected | `7b4c2a6`; review fixes `3c838d9` |
| 2: Today at a glance + scannable rows | `4178abb`; review fixes `c6111d8` (the domain always comes from the sender's address) |
| 5: typography and spacing, slim cards | `7274c59`; review fixes `cd3d665` (`cn()` knows `text-label`, last-`@` `domainOf`, comms address format) |
| PR body, H-052/H-053, plan-review | `e2b69b5` |
| e2e spec fixes | `c266c1f` |
| One-line failure text | `583a816` |
| "After" shots, T-235 done | `7a73ce1` |

Reviews: every part had a full security review and a code review; part 1 also had two security re-checks. No BLOCKER or HIGH is open. Accepted LOW items are in `docs/plan-review.md` under "T-235: logged, not fixed".

## Test results (final tree)
- `pnpm typecheck` and `pnpm lint`: 18/18.
- `pnpm test`: 18/18 plus 216 root script tests (web 892, ui 342, connectors 1428, briefing 98).
- `pnpm test:db`: 45 files. pgTAP 306 has 104 checks.
- `pnpm db:types:check`: ok.
- `pnpm e2e:brain` (full, local reset approved): **18 passed, 13 skipped** (by viewport, by design), **1 failed**.
  - The failure is the 300 ms skeleton timing check (505 ms under load on this 1-core machine). It passes alone, as on Nov 11 and 12.
  - That run includes the axe accessibility checks in light and dark and the iPhone 390 px checks: Home, Settings, Approvals, Finance and Inbox have no sideways scroll, and Reply/Open are 44 px.
- e2e fixes along the way were spec updates only (see `c266c1f`). One of them, the home seed's `UNION` literal typing, had kept `home.spec.ts` from running at all.
- The local `supabase db reset` sometimes times out under load while restarting containers. Re-running works.

## Screenshots (before / after, same synthetic data)
- `docs/design/t-235/before/` and `docs/design/t-235/after/`: `home-1440-light.png`, `home-1920-light.png`, `home-iphone-light.png`, `home-1440-dark.png`.
- The data is the synthetic fixture `apps/web/e2e/fixtures/home-shots.sql` (`example.test` only), loaded by the e2e global setup when `SHOTS_SEED=1`.
- To retake: `SHOTS=1 SHOTS_SEED=1 SHOTS_SET=home SHOTS_OUT=$PWD/docs/design/t-235/after E2E_SPECS=e2e/screenshots.spec.ts pnpm e2e:brain --project=desktop`.

## Production SQL (Saurabh runs it in the Supabase SQL Editor)
The files are git-ignored (`supabase/core/bootstrap/manual-migrations/`), so run them from this checkout. Order:
1. Parts 1–11, as in earlier checkpoints.
2. `part-12-T-234.sql`, then `check-part-12.sql` (31 rows).
3. **`part-13-T-235.sql`**, then **`check-part-13.sql`**: 14 rows, all must be true.
   - One transaction.
   - It refuses to run unless part 12 (`20261113140000`) is recorded.
   - Re-runnable: it drops and re-creates only where a return type changed, re-creates the status check, and writes the version row with `on conflict do nothing`.
   - Contents: migration `20261114100000_briefing_auto_runs`, copied verbatim (checked programmatically). It adds:
     - `brief.briefing_runs` with RLS;
     - `core.briefing_claim_auto`, `core.briefing_claim_regenerate`, `core.briefing_claim_schedule` (returns `{id, gate}`) and `core.briefing_claim_release`;
     - `core.briefing_run_state` and `core.briefing_runs_purge`, plus the `brief.*` internals;
     - `core.briefing_save_own` and `core.briefing_save` re-created with every gate kept.
   - Ran twice against the local DB after a reset; all 14 checks true both times.
4. Deploy after part 13. Home calls the new claim and state functions.

## Needs human (`docs/backlog.md`)
- **H-052:** make one real briefing call with the production `ANTHROPIC_MODEL_ANALYSIS` and confirm the API accepts `output_config.format`. No live call has been made yet.
- **H-053:** on Vercel, confirm the background run (`after()`, 60 s) finishes under Home's `maxDuration` 90. If not, use the Inngest path described in the notes.
- **H-046:** the daily schedule. Its wording no longer mentions Run now.
- Still open from earlier: H-002 (`ANTHROPIC_*` in Vercel), H-045 (parts 9–10), H-047 (live sending), H-048 (resync after part 12), H-049 to H-051 (news).

## Decisions taken (logged; change them if you disagree)
- **KPI figures** now use Inter rather than Source Serif ("everything else Inter").
- **"View all in Inbox · N need attention":** N counts the ranked threads, because the Inbox has no matching filter.
- **The 6/day cap counts every claim,** lost and released ones included. A crash loop still stops at 6.
- **The phone e2e persona** (`finance-operator`) gets no "Connect…" banner by design. The banner is for roles that can connect sources and see finance.

## Next
Run `node scripts/next-task.mjs --explain`.
