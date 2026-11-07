# T-210 independent code review (Nov 7, 2026)

Could not run pgTAP (supabase CLI not on PATH); reviewed 250_brain.test.sql by reading. Ran: brain vitest (35 pass, 1 FAIL), core brain-import-purge test (5 pass), brain tsc and eslint (clean), dependency-allowlist (41 pass), build-templates --check (fresh).

## BLOCKER
1. packages/modules/brain/src/boundaries.test.ts:20-23 fails. The comment added to packages/connectors/src/retention/tables.ts:7-8 names `brain.document_versions` / `brain.import_candidates`, which NAMES_BRAIN_DB matches, so "no connector file touches brain.*" reports tables.ts. `pnpm test` is red (the self-review's "36 tests" is stale). Fix: reword the comment without the schema-qualified names (for example "brain version history and import candidates"), or have the test skip comment lines. Prefer rewording.

## HIGH
none.

## MEDIUM
1. Acceptance says "retention registered with T-042"; the builder only left a comment (tables.ts:7-8) and registered nothing. The reasoning (not a day class) is sound, but the backlog line is not met literally. Fix: add a line in the PR body (.agent/pr/T-210.md) and in the T-210 backlog entry saying retention is done by in-function pruning plus core.brain_import_purge, or register a no-op/hourly entry in the registry. Flag it for Saurabh.
2. supabase/.../20261107090000_brain_schema.sql:783-803 (purge) closes imports only after 24 h but deletes candidates at 23 h. An import in 'review' between 23 h and 24 h has no candidates and still accepts brain.import_decide (it checks only created_at > 24 h); decide then fails with "unknown candidate", or with an empty list finishes "done" with nothing. Fix: in the purge also set status 'failed' for imports older than 23 h (matching the candidate cut), and make import_decide's expiry test 23 h, so the two agree.
3. packages/modules/brain/src/server/store.ts:97-100: every thrown error from clientFor or rpc (network failure, router refusal alike) becomes BrainError("forbidden"). A transient outage then shows "No access". Fix: map a router refusal to forbidden, anything else to "unavailable" (test it).
4. store.ts:243 and migration brain_documents_list limit 500 (ordered by path): in a lane with several owners, other owners' pages can push the caller's own seeds off the list, so ensureSeeds would try to recreate them. Harmless (version_conflict is swallowed) but wasteful; better to check each seed with getDocument or add an `only_mine` argument.
5. Home lane: resolveHomeLane (domain/home-lane.ts:27) silently ignores an existing About-Me lane that is not in openLanes (membership removed, lane disabled) and falls through to Personal/picked, which would seed a second About-Me elsewhere. Spec says it "never moves silently". Fix: if existingLaneId is set but not open, return { ok:false, reason:"home_lane_unavailable" } (add a test).
6. brain.import_decide returns kept facts and deletes candidates in one call (migration 573-576). If the caller crashes before merging the facts into documents, the facts are gone. Acceptable by spec (24 h cap) but T-214 should merge in the same request; note it in the spec's implementation notes.

## LOW
1. Allowed view via memberships.views: a non-owner given the `brain` view can read lane pages, employees (instructions, config) and skills, but not write. About-Me/Preferences stay author-only. Fine; mention in T-211.
2. docs/brain-templates/README.md still exists (untracked) next to the moved copy at packages/modules/brain/templates/README.md; backlog/spec still say "seed files: docs/brain-templates/". Decide: keep a one-line pointer README or delete it, and update backlog line 973.
3. Scope: backlog status set to done and approved wording changed in docs/backlog.md; allowed by CLAUDE.md ("true on merge"), but plan-review.md/spec edits are fine. No code scope creep found: lane-config MODULES, apps/web route + next.config + package.json, allow-list, catalog test are all required by the acceptance list. Constants `v` in the pruning DO block (250_brain.test.sql ~line 78) are unused.
4. brain.employee_save has no no-op short circuit for identical input (document_save has); a repeat save bumps version. Cosmetic.
5. `findHomeLane` (store.ts:221) takes any lane to ask through; if a deployment ever splits lane databases, the answer is per database. Document it, no change now.

## Verified OK (independently)
- Version conflict: if_version 0 = create; missing row with >0, stale, and unique_violation race all give 40001 'version_conflict'; row lock via `for update`; TS maps 40001 and the message. Tests cover stale, create-twice, missing-with-version, no-op.
- Pruning: keeps versions v-19..v (`version <= v-20` deleted) in the same transaction; test saves 25 and expects 6..25. No-op save adds no version row.
- Lazy seeding: no seed in the migration; seeds go through document_save/skill_save (version 1), existing own pages skipped, lost race swallowed. Seed text passes the secret scan (domain test).
- Kind derived from path in SQL and enforced by CHECK; identity trigger blocks changes; versions are append-only with kind/owner copied by trigger, so RLS on versions matches documents.
- RLS: standard AAL2 + allowed_lanes('brain'); About-Me/Preferences author-only; imports/candidates own-user, candidates hidden after 24 h; no user DML grants; service_role has no brain DML; writers check aal2 + owner role + auth.uid() addressing. Catalog entries (custom_policy_ok, security_definer_ok, authenticated_exec_ok) are present and specific.
- Purge timing: hourly cron at :07, delete at >=23 h, so worst case age is under 24 h plus job lag; RLS hides at 24 h as backstop. Job runs one step per lane, tries all lanes, then fails with lane ids only; no token or row data in errors. Wiring in apps/web route is minimal and uses getLaneJobClient.
- Home-lane rule has no hard-coded lane code (order: existing, Personal from configuration, picked, only lane). Tests exist.
- Rules 3, 4, 6, 10: lane_id not null on all six tables, no raw uploads (no storage_path), synthetic personas only.
