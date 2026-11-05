# T-062 code review: findings and resolution

4 HIGH, all fixed; MEDIUMs applied as listed.

HIGH
1. `WatchInfo` could not carry what Google/Graph need for renew/stop. Fixed: `resource_id`, optional `state`; push requires expiry and a channel or resource id; token/clientState stay in the Vault (documented).
2. Multi-calendar and per-folder cursors. Fixed: `CommsCursorSchema` (16 KB, provider-encoded composite per connection); calendar `watch` returns `WatchInfo[]`; mock has a 3-calendar fixture and the contract syncs and watches all three.
3. Cursor binding. Fixed: mock cursor embeds the connection id; strict test uses A's cursor on B with equal change counts; delta asserts `toContain(added)`.
4. Foreign-provider guard. Fixed (see security 1).

MEDIUM applied: fault hooks and tests (auth, rate limit with retry_after_seconds, transient, expired cursor, old cursor still valid after failure); all-day requires timezone and local-midnight instants (Intl), DST fixture; removals documented (true deletes only, removals-first, remove-then-re-add test); cancelled-stub merge doc and incremental test; search plain-text doc and `OR from:` test; `lane_config.providers` removed; `ProposedPayload` -> `ApprovedActionShape` type test (fits, hash computes); `maxChars` on every `readBody`; optional `expect` coverage arg and `_` helpers allowed in `checkNoExecutePath`.

Not done: the type test cannot call `executeWrite` (lint restricts the name outside approvals), so it checks the exported action shape and `actionTypes`; T-116 wires the real executor.
