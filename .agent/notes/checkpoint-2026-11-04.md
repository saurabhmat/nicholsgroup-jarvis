# Checkpoint: Nov 4, 2026

This checkpoint is for the agent or person who picks up the pilot build next. Branch `agent/pilot-build` in `~/dev/pubk-projects/jarvis/pilot-build`, HEAD `07b9b7e`, not pushed. Agents can't push (`.claude/hooks/guard-bash.sh`), so Saurabh pushes. This supersedes the "Next" section of `checkpoint-2026-11-02-b.md`.

## Done this session (commits since 5fa4a86)
- **Design sign-off, batch 1 (D-20)** (`bb2880f`, `4a17d71`, `f39fcaf`):
  - Record: `docs/design/README.md`, with screenshots in `docs/design/batch1/`.
  - Final tokens, plus a dark set (light and dark both ship), plus the chart palette `--chart-1..4`, all in `packages/ui/src/styles/theme.css` and tested.
  - Wordmark is "Jarvis" for every company (D-22).
  - Projects is in Release A (monday.com, read-only); T-150 moved to Release A.
  - "All companies" comes after the pilot.
  - Required changes to the prototype: "book balance" in full, approval cards show the exact payload, Edit on iPhone, a freshness chip on every figure.
- **T-023 app shell** (`b872029`, `2a628f3`), done.
  - Tested against the lane router: a refused lane returns 404.
  - Light and dark mode.
  - The first browser run fixed the sign-in redirects. That also closed **T-018, T-019 and T-020** as done.
- **T-024 navigation and page structure** (`7501beb`, `4055b6f`), done.
  - Headers and sections per the prototype; iPhone band and tab icons.
  - `apps/web` Vitest runner, with `loadLane`, `landingPath` and `mfaPath` tests.
  - The proxy lane check now matches only `^[A-Z]{1,8}$`.
- **T-037** done (`d10d2fe`): Inngest dev server check (`inngest-cli@1.49.0`). The app registers, a lane event runs, and an event without laneId is refused.
- **T-050 QuickBooks OAuth on the sandbox** (`44278b8`): built. Still `approved`; review fixes are in progress (below).
- **Decisions recorded in `docs/backlog.md`:**
  - D-1: Google Workspace for PKG; the Microsoft tasks move to Release B.
  - D-8, partly: PKG, Ask Pub K and Nichols Law each have their own QuickBooks file.
  - D-21: batch 2 design (open).
  - D-22: Jarvis wordmark.
  - D-23: one provider account per lane.
  - D-24: no rule-5 exception. Disconnect runs through the Approval Center, and T-195 now depends on T-113.
- **Approved:** T-036, T-038, T-040, T-050, T-055, T-061, T-062, T-198 (temporary QuickBooks connect and health controls).

## In progress when this was written
A builder subagent is working on the T-050 follow-up. The working tree has its uncommitted changes, and typecheck failed mid-refactor (`laneConfig` in `QboConnectorDeps`).

It is doing three commits:
1. **T-050 review fixes:**
   - Security H1: provider check on every QuickBooks path, plus a cross-provider test.
   - Realm verified through CompanyInfo after the code exchange.
   - The second path into the Vault is closed.
   - Disconnect only on the approvals-only write path (D-24), failing closed.
   - Refresh is not retried after it may have been sent; the token is re-read from the Vault.
   - The bundle scan gets a positive control and moves to `pnpm test:bundle`.
   - Production refuses connect with no realm configured.
   - The `NEXT_DIST_DIR` allowlist.
   - Exact discovery hosts.
   - The canary backup file is removed.
2. **D-23:** a partial unique index on `core.connections` (provider + external account), with pgTAP tests.
3. **T-198:** a "Temporary: connection test" section on Settings with Connect QuickBooks and Check connection, behind a flag.

Reviews of 44278b8: `.agent/notes/review-T-050-{security,code,db}.md`.
- Security: 1 HIGH (H1), 4 MEDIUM.
- Code: 3 MEDIUM.
- DB: clean.

**When the builder reports:**
1. Re-run security-reviewer and code-reviewer on its commits.
2. Run the browser suite. Stop the preview first: it holds port 3100. Command: `cd apps/web && LD_LIBRARY_PATH=~/.local/share/pw-libs/root/usr/lib/x86_64-linux-gnu pnpm test:e2e`.
3. Set T-050 and T-198 to done.
4. Add D-24 to plan-review §7.
5. Reset the preview.

## Waiting on Saurabh
- **Split T-195?** (asked, no answer yet). Proposal:
  - Reconnect, error map and `reconnect_required` before Nov 13.
  - Disconnect (QB-8) later, as an approvals action.
  - H-024 then requires "QB-1 – QB-20 except QB-8".
  - Without the split, H-024 on Nov 13 waits on T-110 – T-113.
- **Credentials:** H-006 (Stripe test-mode restricted key and webhook secret) and H-007 (GoHighLevel token and location). Saurabh said he will add them to `.env.local`.
- **Google:** H-008 (OAuth client, Internal, read-only Gmail/Calendar/Drive) and H-013 (Pub/Sub).
- **Design:**
  - H-029: app icon (blocks T-025).
  - D-21: batch 2 design (Inbox, Calendar, Assistant, Projects, Settings, Finance detail).
  - H-030 (optional): the PDF.
- **D-8:** are Pub K Institute and Nichols Capital separate QuickBooks files or PKG classes? Also, Pub K Group's QBO realm id must be in `lane_config` before H-024, because production fails closed without it.
- **Home greeting:** needs a source for the user's first name ("Good morning, Robert").

## Environment notes
- **Playwright/Chromium:** the system libraries are unpacked without sudo in `~/.local/share/pw-libs`. Run with `LD_LIBRARY_PATH` (`docs/runbooks/e2e-browsers.md`).
- **Preview:**
  - Command: `node apps/web/scripts/e2e-server.mjs`, against local Supabase. It serves 127.0.0.1:3100, with Mailpit on 54324.
  - Before starting, reset with `node -e 'import("./scripts/e2e-reset.mjs").then(m=>m.default())'` from `apps/web`.
  - Sign in as `owner@example.test`.
  - Saurabh is remote (Mac), so he needs `ssh -N -L 3100:127.0.0.1:3100 -L 54324:127.0.0.1:54324 saurabh@72.60.97.219`.
  - Any `pnpm test:db` or e2e run resets the database, which wipes the preview's enrolled users.
- **`scripts/next-task.mjs`:**
  - A backlog task block allows only `status`, `depends`, `needs` and `acceptance` lines; never add `- note`.
  - A `needs` parenthetical must not contain a comma.
- **Agent permissions:** `curl` to localhost is blocked for agents; use `node -e 'fetch(...)'`.
- **Running in parallel:** run one builder at a time on this branch. Tasks that touch SQL share the local database, and e2e needs port 3100.

## Next (build order after the T-050 follow-up)
T-055 (finance schema, part 1) → T-036 (webhook receiver) → T-038 (conn.sync) → T-040 → T-061 and T-062 (comms groundwork) → T-195 (as split) → T-051 – T-053 and T-196 – T-197 for the Nov 12 sandbox run (QB-1 – QB-20, with Saurabh doing the Intuit login) → H-024 live connect on Nov 13. Stripe (T-054) and GoHighLevel (T-059) follow when H-006 and H-007 land.
