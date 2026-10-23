---
description: Build one approved backlog task end to end and leave it ready for PR review
argument-hint: <task-id>
---
Build backlog task $ARGUMENTS.

1. Confirm the task exists in docs/backlog.md with `status: approved` and all depends-on tasks are `done`.
   If not, stop and say why.
2. Create branch `agent/$ARGUMENTS` (if not already on it).
3. Delegate implementation to the `builder` subagent, which uses `db-engineer`, `test-engineer`,
   `security-reviewer` and `code-reviewer` as needed.
4. Ensure the Definition of Done in CLAUDE.md is met.
5. Write the PR body to `.agent/pr/$ARGUMENTS.md`: summary, files changed, tests added, security review
   result, risks, and "Needs human" items.
6. Commit. Do not push — the pipeline pushes and opens the PR.
