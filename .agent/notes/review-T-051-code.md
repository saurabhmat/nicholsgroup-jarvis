Ignoring 31 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["/home/saurabh/dev/pubk-projects/jarvis/main"].hasTrustDialogAccepted: true in /home/saurabh/.claude.json.
**T-051 review: no BLOCKER or HIGH findings.** I did not run `pnpm typecheck`, `lint`, `test` or `test:db`, because this was a read-only pass. A passing run is still needed. I also did not read the fixtures' consumers beyond `sync.test.ts` and `features.test.ts`.

The change matches the acceptance criteria:
- **Entity coverage:** all 11 entities plus CompanyInfo and Preferences are loaded.
- **Cursor:** it is only advanced by the runner's compare-and-swap after `sync` resolves. A cursor older than the 30-day look-back, or a missing, malformed or future one, forces a full reload.
- **CDC cap:** a CDC answer cut off at the 1000-object cap also forces a full reload.
- **Read-only client:** `QboApi` exposes only `get`, and the fake Intuit has a catch-all tripwire for any other path or method.
- **Allowlist:** every entity goes through a strict Zod allowlist, and the tests plant `AcctNum`, `CustomField` and similar hazards in the fixtures.
- **Feature flags:** they are audited before they are saved (`withAudit`, `features.ts:46`).
- **No SQL changes:** so no pgTAP is required.
- **No new dependencies.**

## MEDIUM
1. **"Preferences read on connect" is not met literally.**
   - Nothing triggers a sync after the OAuth callback. Your notes defer this to T-195/T-197 and say the first `conn.sync` run satisfies it.
   - Fix: record that deferral as an explicit "Needs human / scope decision" item in the backlog and the PR body, or enqueue a `connect`-trigger sync from the callback now.
2. **A targeted sync with only singleton types sends an empty CDC request.**
   - Location: `sync.ts:73-76` and `:147`. `objectTypes: ["Preferences"]` gives `entities = []`, which is "targeted" because `0 < 11`. It then calls `/cdc?entities=` with an empty list.
   - Fix: if `entities.length === 0`, skip the CDC call and the data load and only run the singleton step. Add a test.
3. **The sync-level validation runs after network calls and a persisted write.**
   - Location: `sync.ts:115`. The "targeted needs a cursor" `invalid_input` check comes after two Intuit calls and `features.record` (`:111`).
   - Fix: move the `usableCursor` and targeted checks to the top, before any call. This avoids a pointless audit row and token use on a request that will be refused.
4. **The process artifacts in the Definition of done are missing.**
   - `.agent/pr/T-051.md` does not exist, and `docs/plan-review.md` has no entry for T-051's HIGH-and-below items. These are the Intuit behaviours listed in `.agent/notes/T-051.md` as unverified until the Nov 12 sandbox run (H-005).
   - Fix: write the PR body (changes, tests, risks, human items) and log those items in `plan-review.md`.
5. **A full load runs in one invocation.**
   - Location: `sync.ts:119-139`. Large realms could take up to 11 entities × many pages with a rate-limited client, and nothing is chunked into steps.
   - Fix: check the `createConnSyncJob` timeout and retry budget against a worst-case estimate. If it is too tight, log it as a follow-up for T-053/T-090. PKG volume is probably fine.

## LOW
6. **Paging has no stable order.** `sync.ts:36`: `select * from X STARTPOSITION … MAXRESULTS …` has no `ORDERBY Id`. Intuit's default order is by Id, but a stable order is worth requesting. Verify the syntax in the sandbox.
7. **Unverified Intuit shapes.** These are the CDC `changedSince` in `Z` form (`sync.ts:147`), the `status:"Deleted"` shape, the `PrivateNote === "Voided"` marker (`entities.ts:205`) and the capped-answer behaviour. Whether Account `LastUpdatedTime` moves when `CurrentBalance` changes is also unverified. Add these to the H-005 sandbox checklist.
8. **Deletions are missed on a full reload.** A stale-cursor reload cannot see deletions made while the cursor was stale. This is documented in `sync.ts:8` and covered by T-172. Make sure the PR body says so.
9. **The wiring tests match source text with regexes.** `features.test.ts:74-82` breaks on any formatting change and proves little. Keep them, but note they are structural. A behavioural test would be a harness-level `sync` through `createConnectorSyncRunner`; `sync.test.ts` may already cover that.
10. **Money stays as JSON floats in raw.** `entities.ts:29`: this is fine for a raw layer. Make sure T-056 parses to `numeric(18,2)` in SQL, not in JS.
11. **Scope and tidiness.**
    - `.agent/notes/checkpoint-2026-11-02-b.md` and the earlier review notes are untracked and unrelated to this change. Don't commit the checkpoint with this task.
    - The import order in `quickbooks/index.ts` puts `qboFeatureStore` mid-list.
    - `features.ts` (a connector module) is imported by `vault/index.ts` for the store factory. This follows the `cal-store` precedent, so it is acceptable.

## Suggested missing tests
- Singleton-only `objectTypes`, from item 2.
- A sink failure during the CDC emit, to confirm the cursor stays.
- A CDC deletion followed by a replayed older update, if the raw-store test doesn't already cover it. The DB rule at the end of `raw_source_records.sql` appears to handle this.
