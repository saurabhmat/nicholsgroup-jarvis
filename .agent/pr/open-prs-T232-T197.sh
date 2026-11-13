#!/usr/bin/env bash
# Run by a human (agents cannot push). Pushes the unpushed branches and opens stacked PRs, none merged.
# Merge order: T-232 -> T-192 -> T-234 -> T-235 -> T-236 -> T-237 -> T-195 -> T-196 -> T-197.
# Each PR is based on the previous branch. Replaces open-prs-T232-T237.sh.
# Needs: gh auth login. Run from the pilot-build checkout.
# Production SQL before deploying: parts 15, 16, 17 (gitignored, in supabase/core/bootstrap/manual-migrations/), in order,
# each followed by its check-part-N.sql; part 16 MUST run before the T-196 code deploys.
set -euo pipefail

git push -u origin agent/T-237 agent/T-195 agent/T-196 agent/T-197
# Already on origin; a no-op if unchanged.
git push origin agent/T-232 agent/T-192 agent/T-234 agent/T-235 agent/T-236

pr() { # base head title
  gh pr create --base "$1" --head "$2" --title "$3" --body-file ".agent/pr/${2#agent/}.md"
}
pr main         agent/T-232 "T-232: minimal Approval Center for email (email.send, email.save_draft)"
pr agent/T-232  agent/T-192 "T-192: action.reconcile_stuck"
pr agent/T-192  agent/T-234 "T-234: Home v2"
pr agent/T-234  agent/T-235 "T-235: Home polish (from Saurabh's production review)"
pr agent/T-235  agent/T-236 "T-236: AI output limit (briefing and GovCon news survive a cut-off reply)"
pr agent/T-236  agent/T-237 "T-237: Home redesign to the approved PNGs (desktop, reply drawer, iPhone)"
pr agent/T-237  agent/T-195 "T-195: QuickBooks disconnect (approvals), reconnect and Intuit error map"
pr agent/T-195  agent/T-196 "T-196: QuickBooks sync and API error log + audited export"
pr agent/T-196  agent/T-197 "T-197: Settings -> Connections, QuickBooks section"

gh pr list --author @me --state open
