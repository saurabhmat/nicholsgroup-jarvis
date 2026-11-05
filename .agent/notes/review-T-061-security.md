# T-061 security review (security-reviewer subagent, run by the coordinator)
Result: no BLOCKER/HIGH. Findings and resolution:
- Summary approval could survive a text change, ignore lane policy, and name an approver outside the lane: fixed with comms.message_summary_guard (new approval time required, policy must list 'email', approver must be a lane member); pgTAP covers each.
- Label array unbounded element size: fixed with comms.labels_ok.
- Purge intervals could exceed policy: now capped (lane retention_days; 180 days); purge functions are security invoker (service_role privileges suffice), removed from the security-definer list.
- Direct service_role deletes bypass floors, free-text metadata untrusted in prompts: logged in docs/plan-review.md; T-042 acceptance now names the purge functions.
- Cross-lane message denial for a PKG-only owner: test added.
