#!/usr/bin/env bash
# Local unattended loop: builds approved tasks one by one, each on its own branch, opening a PR per task.
# Usage: scripts/run-backlog.sh [max_tasks]   (requires: claude, gh, pnpm, supabase CLI, Docker running)
set -euo pipefail
MAX=${1:-5}
for i in $(seq 1 "$MAX"); do
  git switch main && git pull --ff-only
  # next-task exits 0 with empty output when nothing is ready, and 1 on a backlog error.
  ID=$(node scripts/next-task.mjs) || { echo "next-task failed (backlog error above); stopping."; exit 1; }
  [ -z "$ID" ] && { echo "No approved tasks ready."; exit 0; }
  echo "=== Building $ID ==="
  git switch -c "agent/$ID"
  claude -p "Follow .claude/commands/build-task.md for task $ID." \
    --permission-mode acceptEdits --max-turns 150 --output-format json > ".agent/logs/$ID.json" \
    || { echo "Agent failed on $ID — see .agent/logs/$ID.json"; exit 1; }
  git push -u origin "agent/$ID"
  gh pr create --base main --head "agent/$ID" --title "$ID (agent)" \
    --body-file ".agent/pr/$ID.md" --label agent-pr
  # Next task waits for its dependencies to be merged (status: done) — approve PRs to keep the loop moving.
done
