# Teams: pictures, new-message dot, second account, tidier Messages (T-285 to T-287, T-289 to T-291, T-294 to T-297)

This pull request carries every reviewed Teams piece built after phases 1 and 2 (PR #71), stacked in one branch. Each piece has its own full description in the repository; this page is the summary and the order of the production steps. The Send button (T-288) is NOT in this pull request.

| Piece | Tasks | Full description | Production SQL |
|---|---|---|---|
| Sending, server side only | T-286, T-287 | `.agent/pr/T-286.md` | Part 35 |
| Pictures in messages, reading team channels | T-285, T-291 | `.agent/pr/T-291.md` | none |
| New-message notices and the "new" dot | T-289, T-290 | `.agent/pr/T-289.md` | Part 36 |
| Several Teams accounts per person, combined chat list | T-294, T-295 | `.agent/pr/T-294.md` | Part 37, then the limit setting |
| Channels per account, chat list kept mounted, tidier conversation pane | T-296, T-297 | `.agent/pr/T-296.md` | none |

## What changes for a person after the deploy

- **Pictures** in Teams chat messages are shown (tap to load).
- **A dot beside Messages** when a new Teams message has arrived, and the open Messages page refreshes itself. It starts after the Inngest sync and the next subscription scan, and only if Microsoft accepts the subscription.
- **A second Teams account** can be connected in Settings once the company's limit is raised (a short SQL step after the deploy). Messages then shows one combined list with a label per chat for its account.
- **A tidier Messages page:** a slim connection row, a one-row chat header, grouped messages with day separators, narrower bubbles, each pane scrolling on its own. Clicking a chat no longer re-reads the chat list.
- **Nothing can be sent yet.** There is no Send box in this pull request; the bottom of a chat shows one line saying so.
- **Channels stay hidden** until the company's settings list `channels_read` and the Entra permissions are granted.

## Review

Every piece had a security review, a code review and a re-check of its fixes. All BLOCKER and HIGH findings are fixed; accepted LOW items are listed in `docs/plan-review.md`.

## Checks

On the last commit of each piece the builder reports `pnpm typecheck`, `pnpm lint`, `pnpm test` and the web build passing, and pgTAP (`node scripts/test-db.mjs --no-reset`) passing wherever SQL changed. Not run: Playwright and the end-to-end suites, a database reset, anything live against Microsoft. **Nobody has seen the new Messages layout in a browser**; the visual check after the deploy is item H-087 in `docs/backlog.md`.

## Production steps, in this order

1. Before merging, in the production SQL Editor, each part with its read-only precheck first and its read-only check after:
   - Part 35: `part-35-T-286-precheck.sql` (24 rows), `part-35-T-286.sql`, `part-35-T-286-check.sql` (34 rows).
   - Part 36: `part-36-T-289-precheck.sql` (23 rows), `part-36-T-289.sql`, `part-36-T-289-check.sql` (35 rows).
   - Part 37: `part-37-T-294-precheck.sql` (18 rows), `part-37-T-294.sql`, `part-37-T-294-check.sql` (18 rows).
2. Merge; wait for the production deploy.
3. Inngest: sync the new deployment (new function `teams-activity`), then invoke `conn-subscriptions-renew-scan`.
4. Only after the deploy: `teams-accounts-limit-H-085.sql`, then `check-teams-accounts-limit-H-085.sql` (13 rows). An older deployment would read the new setting as malformed and pause Teams for the company.
5. Live checks: H-083 (notices), H-085 (second account), H-087 (how the page looks).

Every part runs in one transaction, refuses a second run, refuses when an earlier part is missing or an object it relies on differs from the repository, and changes no existing row. If a precheck row is false, stop.

## Risks and open points

- Whether Microsoft accepts a subscription covering all of a person's chats, and for how long, is not yet seen live. If refused, the dot never appears and Settings says "Live updates unavailable".
- Whether Microsoft shows its account picker when a second account is connected while the first is signed in in the browser is not yet seen live; the portal then says "already connected" and nothing changes.
- The layout rests on CSS reasoning and render tests only.
- A Messages tab left open from before the deploy gets errors on some actions until it is reloaded.
- The notification receiver is shared with mail and calendar; its logic for them is unchanged except that one failing item no longer drops the other items of a delivery.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
