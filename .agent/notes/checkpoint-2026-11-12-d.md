# Checkpoint — Nov 12, 2026 (d): T-237 Home redesign done

Checkout `~/dev/pubk-projects/jarvis/pilot-build`, branch **`agent/T-237`** (from `agent/T-236`). Nothing is pushed (agents can't push). The previous checkpoint is `checkpoint-2026-11-12-c.md` (T-236).

## Push / merge order
Each branch contains the one before it; merge in this order with merge commits:
1. `agent/T-232`
2. `agent/T-192`
3. `agent/T-234`
4. `agent/T-235`
5. `agent/T-236`
6. **`agent/T-237`** (PR body: `.agent/pr/T-237.md`)

## Production SQL (run in the Supabase SQL Editor from this checkout; the files are git-ignored)
1. Parts 1–13, as in earlier checkpoints. T-236 needs no SQL.
2. **`part-14-T-237.sql`**, then **`check-part-14.sql`**: 6 rows, all must be true.
   - One transaction, re-runnable.
   - Refuses unless part 13 (20261114100000) is recorded.
   - Adds `core.home_finance_detail` (migration 20261115100000, copied verbatim).
   - Ran twice locally; all checks true both times.
3. Deploy T-237 after part 14. Home calls `core.home_finance_detail`.

## Results
- `pnpm typecheck`, `pnpm lint` and `pnpm test`: 18/18 plus 216 root script tests.
- `pnpm test:db`: 46 files, 2866 tests (pgTAP 307 has 53).
- Full `pnpm e2e:brain`: 17 passed, 13 skipped, 2 failed.
  - Both failures are load-sensitive: the 300 ms skeleton check and `brain-import.spec.ts:141`, which passed 4/4 alone.
  - The new `home-layout.spec.ts` and `home-reply-draft.spec.ts` pass.
- Screenshots: before is `docs/design/t-235/after/`; after is `docs/design/t-237/after/` (synthetic fixture, with QuickBooks not connected and news off). Reference images are in `docs/design/home/`.

## Needs human
- **H-055:** part-14 SQL (above).
- **H-056:** Robert's `display_name`, plus the decisions in `.agent/pr/T-237.md` → "Needs Saurabh".
- Still open: H-052/H-054 (AI contract test), H-053, H-046, H-002, H-045, H-047, H-048 and H-049 to H-051.

## Next
Run `node scripts/next-task.mjs --explain`.
