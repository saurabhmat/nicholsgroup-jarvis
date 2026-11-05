# T-061 code review (code-reviewer subagent, run by the coordinator)
Result: no BLOCKER/HIGH. Findings and resolution:
- Cancelled event stubs have no times: start_at/end_at nullable only for status 'cancelled'; separate deleted column dropped; null-safe order check.
- All-day events: start_date/end_date (end exclusive) required when all_day.
- messages.deleted semantics documented (provider-removed; trash stays a label).
- Index (lane_id, end_at) added for purge; purge ages stubs by updated_at.
- Two identical identity guards replaced by one core.forbid_identity_change.
- Provider notes (Graph ImmutableId, singleEvents/syncToken, upsert guard) logged in docs/plan-review.md.
