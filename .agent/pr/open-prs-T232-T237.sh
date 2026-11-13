#!/usr/bin/env bash
# Run by a human (agents cannot push). Pushes agent/T-237 and opens stacked PRs, none merged.
# Merge order: T-232 -> T-192 -> T-234 -> T-235 -> T-236 -> T-237. Each PR is based on the previous branch.
# Needs: gh auth login. Run from the pilot-build checkout.
set -euo pipefail

git push -u origin agent/T-237
# The others are already on origin; this is a no-op if they are unchanged.
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

gh pr list --author @me --state open
