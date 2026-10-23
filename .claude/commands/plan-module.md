---
description: Write the spec and backlog tasks for one module
argument-hint: <module-name>
---
Use the `planner` subagent to produce `docs/specs/$ARGUMENTS.md` and proposed tasks in `docs/backlog.md`
for module $ARGUMENTS, based on docs/architecture.md. Commit on branch `agent/plan-$ARGUMENTS`.
Write the PR body to `.agent/pr/plan-$ARGUMENTS.md` listing open questions for a human.
