# Teams phases 3 to 5: sending (server side), pictures, channels, new-message notices (T-285 to T-287, T-289 to T-291)

This pull request carries three reviewed pieces stacked on phases 1 and 2 (T-278 to T-284). Each has its own full description in the repository; this page is the summary and the order of the production steps.

| Piece | Tasks | Full description | Production SQL |
|---|---|---|---|
| Sending, server side | T-286, T-287 | `.agent/pr/T-286.md` | Part 35 |
| Pictures in messages, reading team channels | T-285, T-291 | `.agent/pr/T-291.md` | none |
| New-message notices and the "new" dot | T-289, T-290 | `.agent/pr/T-289.md` | Part 36 |

## What changes for a person after the deploy

- **Pictures** in Teams chat messages are shown (tap to load), through the portal's own address.
- **A dot beside Messages** when a new Teams message has arrived, and the open Messages page refreshes itself. This starts only after Part 36, the Inngest sync and the next subscription scan, and only if Microsoft accepts the subscription (H-083).
- **Nothing can be sent yet.** The server side of sending is in place, but there is no Send button (T-288 waits for D-67), and sending also needs the steps of H-082.
- **Channels stay hidden** until the company's settings list `channels_read` and the Entra permissions of H-084 are granted.

## Review

Every piece had a security review, a code review and a security re-check of the fixes. All BLOCKER and HIGH findings are fixed; the accepted LOW items are listed in `docs/plan-review.md`. The HIGH findings and their fixes are described in the three files above.

## Checks

On the last commit of each piece the builder reports `pnpm typecheck`, `pnpm lint`, `pnpm test`, the web build and pgTAP (`node scripts/test-db.mjs --no-reset`) passing. Not run: Playwright and the end-to-end suites, a database reset, anything live against Microsoft.

## Production steps, in this order

1. Parts 33 and 34 must already be applied (phases 1 and 2).
2. **Before merging:** `part-35-T-286-precheck.sql` (24 rows, all true), `part-35-T-286.sql`, `part-35-T-286-check.sql` (34 rows, all true).
3. **Before merging:** `part-36-T-289-precheck.sql` (23 rows, all true), `part-36-T-289.sql`, `part-36-T-289-check.sql` (35 rows, all true). Part 36 must be in place before this code is deployed: without it the twice-daily renewal scan would create a Teams subscription at Microsoft that the database refuses to record, and the Messages activity address would call functions that do not exist yet.
4. Merge; wait for the deploy.
5. Inngest: sync the new deployment (new function `teams-activity`), then invoke `conn-subscriptions-renew-scan`.
6. Live checks: H-083 (notices). Later, each with its own steps: H-082 (sending), H-084 (channels).

Every part runs in one transaction, refuses a second run, and refuses when an object it relies on differs from the repository. If a precheck row is false, stop and send the rows.

## Risks and open points

- Whether Microsoft accepts a subscription covering all of a person's chats with a delegated permission, and for how long, is taken from its documentation and not yet seen live. If refused, the dot never appears and Settings says "Live updates unavailable"; nothing else is affected.
- The notification receiver is shared with mail and calendar. Its logic for them is unchanged, except that one failing item no longer drops the other items of the same delivery; it now makes two lookups per company per delivery.
- The picture address shape, picture throttling, and the lookup window after an unknown send outcome are assumptions the live tests settle.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
