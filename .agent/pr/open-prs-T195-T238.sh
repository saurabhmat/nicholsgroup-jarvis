#!/usr/bin/env bash
# Run by a human (agents cannot push). Pushes the QuickBooks branches and T-238, and opens stacked PRs. Nothing is merged.
# T-232 to T-237 are already merged into main (PR #32), so the chain starts at T-195:
#   T-195 -> main, T-196 -> T-195, T-197 -> T-196, T-238 -> T-197.
# Merge in that order, with merge commits. This replaces open-prs-T232-T197.sh.
# Needs: gh auth login. Run from the pilot-build checkout.
# Production SQL: before each deploy, run parts 15, 16, 17 and 18 in order (gitignored, in supabase/core/bootstrap/manual-migrations/),
# each followed by its check-part-N.sql.
#   - Part 16 MUST run before the T-196 code deploys.
#   - Part 18 needs part 17 and MUST run before the T-238 code deploys.
# After the T-238 deploy, sync the Inngest app (H-058).
set -euo pipefail

git push -u origin agent/T-195 agent/T-196 agent/T-197 agent/T-238

pr() { # base head title
  gh pr create --base "$1" --head "$2" --title "$3" --body-file ".agent/pr/${2#agent/}.md"
}
pr main         agent/T-195 "T-195: QuickBooks disconnect (approvals), reconnect and Intuit error map"
pr agent/T-195  agent/T-196 "T-196: QuickBooks sync and API error log + audited export"
pr agent/T-196  agent/T-197 "T-197: Settings -> Connections, QuickBooks section"
pr agent/T-197  agent/T-238 "T-238: sync freshness (Gmail delta schedule, Sync now, Reconnect per connection, sync status line, failure alerts)"

gh pr list --author @me --state open
