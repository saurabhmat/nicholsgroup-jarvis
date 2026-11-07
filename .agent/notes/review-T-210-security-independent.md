# T-210 independent security review (security-reviewer subagent, Nov 7, 2026)

Saved by the main session from the reviewer's report (the reviewer was read-only).

BLOCKER: none.

HIGH
- H-1 Secret scan bypass: `NAME=sk_live_...`, `token:ghp_...`, `key:AKIA...`, `?api_key=...`, `aws_secret_access_key = ...`,
  `password: Hunter2-...` all passed brain.text_has_secret / containsSecret (`:` and `=` kept inside tokens; value patterns
  anchor at token start). **Fixed**: second split on `[^A-Za-z0-9_./+~-]+`, key/value check (name `=` 8+ chars, or name `:`
  8+ chars containing a digit), SQL + TS together; pgTAP (6 refusals + 1 prose acceptance) and Vitest cases.

MEDIUM (deferred, logged in docs/plan-review.md "T-210 build review")
- M-1 Another owner's pages/skills/employees reachable through document_get fallback and the list wrappers; T-212 must use own rows only.
- M-2 No screen for never-store data (SSN, bank/routing numbers); required in the T-214 import writer; product question for free-text pages.

LOW (deferred, logged)
- L-1 created_at not locked on imports/import_candidates; status can leave done/failed.
- L-2 About-Me/Preferences not unique per user across lanes.
- L-3 ClientFor accepts the RLS-bypassing job client structurally.
- L-4 brain view not gated by lane_config.enabled_modules in SQL (app gating).
- L-5 import_candidates.target_lane not checked at insert (T-214).

Verified: definer writers set search_path = '', assert_owner (aal2, auth.uid, owner role in enabled lane); service_role cannot run
writers/wrappers; no user DML; brain schema not exposed; owner-only reads for About-Me/Preferences/imports; 24 h candidate read cap;
append-only versions; purge is definer, service_role-only, one enabled lane; fixed error texts; LIKE prefix escaped; no logging added.
