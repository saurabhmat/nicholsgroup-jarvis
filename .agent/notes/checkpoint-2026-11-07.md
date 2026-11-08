# Checkpoint — Nov 7, 2026 (night)

Branch `agent/brain` in `~/dev/pubk-projects/jarvis/pilot-build`. Not pushed since `52b4adc`. PR #19 (T-210) was merged to `main` by Saurabh (`20293da`).
Tooling: `export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH` (pnpm, supabase). Never reset the local DB (`node scripts/test-db.mjs --no-reset`).

## Commits on agent/brain after the merged PR
- `59262a0` T-210 follow-up: retention catalog (`RetentionRegistry.declare`, BRAIN_RETENTION) + sensitive-number screen (migration `20261107100000`, shared 48-case fixture). Reviewed twice; all HIGH/MEDIUM fixed. Saurabh confirmed: "account" needs 8+ digits; the Luhn false positive on unbroken 13–19 digit ids is accepted.
- `63bae79` **T-211 done** (security + code review: no BLOCKER/HIGH; MEDIUMs fixed; runtime rules carried into T-212/T-213 acceptance).
- `e4f74d9` **T-100 committed, review pending** (cherry-picked from builder worktree commit `b5e8b59`). All checks green on the combined branch. Backlog status still `approved` — set `done` only after the reviews below are handled.

## In flight / next (order agreed: T-211 → T-100 → T-101 → T-102 → T-212)
1. **T-100 reviews**: code review is IN (`.agent/notes/review-T-100-code.md`: no BLOCKER, 3 HIGH interface gaps — prompt-caching/system blocks, tool_result round-trip validation, streamed requestId — plus MEDIUMs; fix before T-101). Security review also IN (`.agent/notes/review-T-100-security.md`: no BLOCKER/HIGH; 3 MEDIUM — pin SDK baseURL/logLevel/OTel content mode against env overrides, validate maxTokens + timeout + retry policy, move mock to `@nichols/ai/testing`). Both reviews are in; next step is fixing them (combine with code-review HIGHs), then T-100 `done`. `security-reviewer` and `code-reviewer` were started on `e4f74d9` at end of session. If their results are lost, re-run both (full review: it handles the API key). Fix BLOCKER/HIGH, amend or add a fix commit, set T-100 `done`, add review notes to `.agent/pr/T-100.md`.
2. **T-101 not started.** The builder worktree starts from `main` (`20293da`), and `git reset --hard e4f74d9` inside it was denied by the permission system. Next time: give the builder the main checkout (no worktree; tree is clean) or ask Saurabh how to base a worktree on `agent/brain`. Full security + code review required (policy gate).
3. Then T-102, T-212. Commit per task, don't push.
4. H-002: Saurabh adds `ANTHROPIC_API_KEY` to `.env.local` (all three `ANTHROPIC_*` vars set together).

## T-162 report (asked for "once T-101 is under way"; drafted, not yet sent)
Chain: T-162 ← T-104 (← T-101, T-081), T-123 (← T-121 ← T-120, T-102; T-101), T-133 (← T-130 done, T-101), T-112 (← T-111 ← T-110; needs D-19 = decided). Done already: T-056, T-017, T-020, T-030, T-063, T-064, T-130, T-042, T-015, T-199, T-211. Finance figures also wait on D-8 (Sophie).
Proposed **Briefing v1 for Nov 25** (split like T-200 was from T-163; merges T-162 core + T-213):
- Reads SQL directly through `security invoker` functions (like `core.home_meetings` / `core.home_mail_attention`), not through T-101 tools, so it does not wait for T-104/T-123/T-133/T-112.
- Mail: `comms.message_index` (subject, sender, `is_important`, labels) + `lane_config.priority_senders` + employee `vip_senders`; no comms.classify (T-121) in v1. Subjects/senders are untrusted (rule 9, T-102 wrapping).
- Calendar: `cal.event_index`, today + `calendar.days_ahead`.
- Brain/profile: T-212 prompt assembly; config via `loadEmployeeConfig` + `effectivePermissionsByLane` every run.
- Output: `brief.briefings` (lane_id, owner RLS, pgTAP, retention), facts separate from recommendations, numeric grounding, coverage section; reply suggestions as text only (no `proposeAction`, no drafts until approvals exist).
- Schedule: `briefing.dispatch` cron, 06:30 America/New_York Mon–Fri, idempotency (employee, local date), DST tests; "Run now" on Home.
- Finance and approvals sections: off by flag; switched on when T-104 (+ D-8) and T-112 land.
- Critical path: T-101 → T-102 → T-212 → Briefing v1.
- Decisions for Saurabh: (1) approve the split as a new task vs re-scope T-162; (2) mail priority from Gmail IMPORTANT + priority/VIP senders (no classifier) OK for v1; (3) subjects and sender names may appear in the briefing text (stored metadata, not bodies).
