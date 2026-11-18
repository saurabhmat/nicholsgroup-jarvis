# Plan: Microsoft 365 mail and calendar connector (D-48)

Planning only: no code, no migrations. Branch `docs/microsoft-connector-plan`.

## What was planned
- **Spec** `docs/specs/microsoft.md` (status: proposed). A native Microsoft Graph connector behind the existing T-062 interfaces; provider chosen per lane in `lane_config`; one multi-tenant Entra app with tenant and cloud per lane and per connection; Google-style connect with tenant, domain, account and ownership checks; per-folder mail delta with a bounded composite cursor; calendarView delta with a D-26-style selection; bodies only live; save-draft/send only through approvals with a marker for "execute once"; change notifications as later tasks; NC enablement (D-50) and a PKG cut-over runbook; a "Verify before building" list (V-1 to V-22) for every Microsoft fact taken from memory.
- **Backlog** `docs/backlog.md`:
  - T-066, T-067, T-068 re-planned (ids kept) and moved with the new tasks to a new **Phase B9 — Microsoft 365 mail and calendar**; a pointer is left in Phase A5; the W10 row updated.
  - New tasks T-250 – T-268, all `status: proposed`. Build order: T-250, T-251, T-254, T-252, T-253, T-255, T-256, T-066, T-257, T-258, T-259, T-260, T-067, T-261, T-262, T-263, T-265, T-266, T-068, T-264, then T-267 and T-268 only if needed.
  - New human items H-066 – H-073 and decisions D-54 – D-56 (with defaults, so building on fakes is not blocked).
  - T-187 unchanged (still depends on T-067, whose id was kept).
  - No existing D- or H- item was changed.

## Open questions for a human
1. **D-54**: one mail provider per lane (default) or both during a migration?
2. **D-55**: Microsoft Disconnect as a local action without approvals (default yes)? Microsoft has no per-app revoke a user's token can call (to verify).
3. **D-56**: first live test: local smoke on a synthetic Microsoft test tenant (H-066), then Robert's nichols.capital mailbox in production `NC` (recommended). Also confirm NC roles (Robert owner, Saurabh admin_technical).
4. **H-063 / H-067**: who grants admin consent in Nichols Capital; whether to do publisher verification.
5. **H-064 / H-065**: GCC vs GCC High for nichols.law; one tenant or several after the migration; four accounts vs shared mailboxes; dates.
6. Focused Inbox "Other" excluded from "Needs your attention" by default? Sync the Archive folder for Microsoft lanes? (Defaults: no and no.)
7. **D-49, D-51** (Robert): GCC content through commercial services; Nichols Law mail at all. Nothing in this plan connects a GCC or nichols.law mailbox.

## Risks
- **Unverified Graph facts.** Permission names, delta behaviour, id character set, deltaLink length, subscription lifetimes, AADSTS codes, GCC detection and the idempotency marker (custom header / extended property on drafts) are from memory. Each task must check its V-items first and stop if the spec is wrong.
- **Cursor size.** Graph deltaLinks may be long; calendars are capped at 5 per connection and folders at 3 until real lengths are measured (H-070).
- **Write scope breadth.** `Mail.ReadWrite` allows deletes. The guard is a write-client allow-list of four method + path templates and approvals-only import; security review must confirm.
- **Admin consent.** Tenants that block user consent leave the user on Microsoft's "Need admin approval" page; the admin consent link is the mitigation. Whether showing that link is an external write by the portal is for security review (the plan says no: the admin acts at Microsoft, the portal stores and calls nothing).
- **Header flags.** Priority-sender top tier relies on `is_auth_pass`; it stays false for Microsoft mail until the Exchange `Authentication-Results` shape is verified (fail closed, but VIP mail ranks lower meanwhile).
- **Cut-over duplicates.** Migrated mail would show twice (Google copy and Microsoft copy) unless readers hide rows of disconnected connections; T-266 checks every reader.
- **Schedule.** 22 tasks of up to a day each; none is Release A. SQL tasks T-254, T-252, T-253 run serially (shared functions).

## Found while planning (conflicts with the brief or docs)
- T-244 – T-247 have no entries in `docs/backlog.md` (only `.agent/tasks/` and `.agent/pr/` files); T-249 depends on T-247. New tasks therefore depend on done tasks (T-031, T-035, T-063, T-064, T-199, T-232, T-238) rather than T-247.
- H-061 is referenced in `docs/plan-review.md` (T-246) but does not exist under "Needs human".
- `docs/architecture.md` "Read this first" item 2 says "No Graph connector for the NL tenant"; consistent with D-51 being open, and this plan does not enable NL.
- `comms/schemas.ts` imports `isMailAddress` from `google/headers` (a Google dependency in the shared schema); T-255 moves it.
- `scripts/next-task.mjs` allows only `status/depends/needs/acceptance/note` lines in a task block, so the spec reference is the first words of each acceptance line, as in earlier tasks.

## Tests
None (docs only). The backlog grammar was checked by reading `scripts/next-task.mjs`; run `node scripts/next-task.mjs --explain` to confirm it parses.
