# Checkpoint — Nov 2, 2026

Branch `agent/pilot-build` in `~/dev/pubk-projects/jarvis/T-005` (pushed). Supersedes the Oct 31 note's "Next".

## Done today
- Approved by Saurabh: T-031 – T-035, T-039 (commit db4c8d5).
- **T-031 + T-032 done** (87b5f35, review fixes 5e90976): core.connections, core.sync_runs, Vault token functions (store = connect/reconnect, read, rotate, revoke = disconnect; row-locked, audited). Security + code reviews run, HIGH fixed. PR notes in `.agent/pr/T-031.md`, `T-032.md`. pgTAP 10 files pass.

## In progress
- **T-033** (689b2b4, pending review fixes): SecretValue, token vault (`packages/connectors/src/vault`), DB connection loader, shared redacting logger (`src/log`), ConnectorError redacts messages, lint rule `no-vault-access` + restricted names. Security review: **2 HIGH + 4 MEDIUM to fix** — see `.agent/notes/review-T-033-security.md`. The code review was still running at pause; re-run it if its result is lost.
- **T-034** (WIP commit, not reviewed): `packages/connectors/src/http/{client,rate-limit}.ts` + tests (26), MSW 3.0.3 harness at `@nichols/connectors/testing/msw` with a folder per provider. Last edits (MSW 3 option `onUnhandledFrame`, body type, unmocked-request test) are in, but the full `pnpm typecheck && pnpm lint && pnpm test` was interrupted — run it first.

## Next
1. Run full checks; fix T-033 HIGH/MEDIUM; PR notes T-033/T-034; reviews for T-034.
2. T-035 (OAuth framework), then T-039, T-038 (needs T-037 done).

## Waiting on Saurabh
- Inngest local dev check (no account needed) → finishes T-037. Inngest account/keys (H-003) only before production.
- Sentry DSN (H-011) → approve T-041.
- Playwright browser tests (T-018 – T-020); D-8 from Sophie by Nov 13; H-023, H-012; D-20 canvas link + final tokens.
