# Pilot security test report (T-170)

Date: Nov 24, 2026. Branch `agent/T-170`. Written for the technical lead and the sponsor. Synthetic data only; nothing here touched production,
a live provider or a real person's records. The plan and inventory are in `docs/security/pilot-test-plan.md`.

## 1. Verdict

**No open BLOCKER and no open HIGH finding.** The suite found one MEDIUM and several LOW findings (section 4); none lets someone read another
company's data, skip the approval chain, or reach a token. Approvals being live for PKG (D-71, Nov 24) is not contradicted by anything the suite found.

What that means, plainly: for the things the suite looks at, the database and the code behave as the rules say. It does not mean the system is
secure in every respect (section 6 says what a passing suite does not prove, and section 5 lists what still needs a person or a staging run).

## 2. What was tested and how

All subjects are found from the database catalog, the file system or a code registry. A new table, function, route, provider, action type or
console call fails the suite until someone classifies it; a stale classification fails too.

| Area | What is proven | Tests | Catalog-driven |
|---|---|---|---|
| Database isolation, tables (`335`) | For all 45 app tables and the one view: the table's real policy, evaluated as the real role with real login claims, refuses (a) a login without the second factor, (b) a member of another company, (c) a company that does not exist, and (d) another person's row for owner-only data (mail, calendar, Teams read markers and activity, approvals, briefings, imports, personal brain documents). Positive controls show the probe can say yes, and a deliberately open policy shows it can say "allowed". Real-row counts at AAL1 and from another lane are zero on every table and view. | 16 | Yes (pg_class, pg_policy) |
| Database isolation, functions (`336`) | For all 92 functions that a signed-in user can call: asking for another company, asking without the second factor, or asking about another person gives an error or exactly the answer for something that does not exist (no data, no "this company exists" signal). Owner-only reads (inbox, Teams read markers, approvals) shown with real rows: the owner sees them, the admin of the same company does not. | 12 | Yes (pg_proc) |
| Approvals, types and classes (`334`, vitest `action-catalog`) | The six action types the database allows (email send, email draft, QuickBooks disconnect, Teams chat send, channel post, channel reply) equal the TypeScript list and have a writer; the policy classes `calendar`, `monday` and `notion` are accepted by the lane policy but back nothing: no combination of classes enables any other type; names a monday, Notion, calendar, Google-revoke or payment action would have cannot even be proposed. | 10 + 5 | Yes (function bodies, constraint, migrations, writer constants) |
| Approvals, gates matrix (`338`) | For every allowed type, on a fresh proposal each: exact-hash approval then a single claim works; wrong hash, no or old second-factor code, no second factor at all, approvals switched off, class removed, connection disconnected, expired, wrong person, another company (member and non-member), second approve, second claim, claim before approval, payload/hash/target changed after approval, and (at claim time) switch off, class removed, connection disconnected, approver demoted are all refused with the expected reason and the status stays correct. | 22 (19 scenarios x 6 types) | Yes (types read from the database) |
| Routes and pages (`route-inventory`) | Every `route.ts` (28 files, 40 methods), every `page.tsx` (20) and every server-action file (4) is classified: session, second factor, company, role, step-up, same-origin check on state changes, module gate. The source of each route and its handler is checked for the claimed guard. Public routes (Inngest, two webhooks, e-mail link) must state why. Inngest signing in production is asserted. | 39 | Yes (file system) |
| Webhooks (`spoofing-catalog`) | For QuickBooks (the one registered signed provider) and Microsoft Graph (mail, calendar, Teams): no/wrong/forged signature or clientState, altered body, signature of one delivery on another, wrong media type, oversize, GET, missing or short secret, replay, unknown account, a body that names another company or connection, hostile content (never forwarded, stored or logged), unregistered path guesses. Every provider name the contract knows must have a receiver or a checked reason for none. | 22 | Yes (registry, provider list) |
| Tokens and secrets (`337`, `canary-sinks`, `console-sites`) | Database: every JSON column is guarded against secrets or reviewed; no column is named like a secret except Vault references; the guard flags token key names and vendor/JWT strings; a fake token in audit or lane config is refused. Connectors: for each of the four connector families, a credential echoed by the provider (never seen or registered by the Vault, and registered) does not reach an error, its JSON, inspect output, a log entry, redacted fields or the stored API-error scrub. Code: every file that logs with `console` is reviewed and none passes a bare error, request, response, header or token. | 8 + 14 + 46 | Yes (columns, provider folders, file system) |
| Prompt injection (`real-registry`, existing `injection`) | The whole hostile corpus is run through a model scripted to obey it, against the REAL tool registry (two read tools): only the two reads run, every other or forged call (other company, extra fields, huge limits) is refused and audited without argument values, the database is asked only for the gate and the two reads and always for the right company, hostile text arrives wrapped, no credential appears. The five places a model is called are listed and none can reach an approval, write client or service client; the reply drafter only proposes. | 21 | Yes (registry, call sites) |
| Security headers, sign-in counter | Pinned known defects F-01 and F-02 (expected failures). | 3 (2 expected fail) | No |

New tests: 68 pgTAP assertions in 5 files and 150 vitest tests in 7 files (the 2 expected failures included). Together with the existing approval,
isolation, webhook, boundary and injection tests (listed in the plan, section 1 to 7) this is the pilot security suite.

## 3. Results

All new tests pass (the two expected failures are the pinned findings F-01 and F-02). Exact runs on the final tree are in section 8.

## 4. Findings

Severity scale: BLOCKER (stop, mitigate now), HIGH (fix before relying on it), MEDIUM, LOW. Nothing is BLOCKER or HIGH.

| id | Sev | Finding | Where | Scenario | Suggested fix |
|---|---|---|---|---|---|
| F-01 | MEDIUM | The app sets no Content-Security-Policy, no framing restriction (X-Frame-Options or frame-ancestors) and no nosniff header; it sets only Referrer-Policy. Pinned by `it.fails` in `apps/web/tests/security-headers.test.ts`. | `apps/web/next.config.ts:18-20` | A hostile page frames the portal and tries to trick a signed-in person into pressing a button. Limited today: session cookies are SameSite=Lax (not sent to a cross-site frame), and every approval needs a fresh authenticator code. | Add `headers()` entries: `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (then a full CSP), `X-Content-Type-Options: nosniff`; confirm HSTS on `portal.pub-k.org`. Then remove `.fails`. |
| F-02 | LOW | The wrong-code counter of the e-mail sign-in is held in an unsigned cookie the browser controls, so a script can reset it. Pinned by `it.fails`. | `apps/web/app/sign-in/actions.ts:15-58` | Someone guessing the 6-digit e-mail code resets the cookie to keep guessing. The real limits are Supabase's OTP limits and the second factor; an e-mail-code-only session (AAL1) reads no data. | Count attempts server-side per address (or rely on and verify the hosted OTP limits, section 5). |
| F-03 | LOW | The lane policy accepts the classes `calendar`, `monday`, `notion` but no action type, writer or gate exists for them; `googleWriter` (`google.revoke_grant`) exists but the database refuses that type. All are inert today (tested), but a lane that lists them gives a false impression of what is allowed, and a future type could be wired without tests. | `core.lane_policies` check; `packages/connectors/src/google/writer.ts:22` | None today. The catalog tests fail the day a type or class changes. | Either remove the unused classes and the unreachable writer, or build them with tests. |
| F-04 | LOW | Stripe, GoHighLevel, monday.com, Notion and TimeSolv exist only as provider names: there is no connector, webhook or executor. Revenue "never double-count" (rule 8) and monday/Notion tampering tests have nothing to test yet. | `packages/connectors/src/contract/schemas.ts:14` | None; the pilot scope still lists them. | Build their tests with the connectors; the provider-coverage tests fail when a folder appears. |
| F-05 | LOW | About 40 files log with `console.*` outside the redacting connector logger. All reviewed passes names, ids or counts only (checked by the suite), but the redaction does not protect them. | list in `apps/web/tests/console-sites.test.ts` | A future edit logs a caught error object that carries a provider message. | The suite now fails on a bare error or request argument; consider routing all server logging through one redacting logger. |
| F-06 | LOW | The original injection suite used its own fake tools, not the real registry. Now covered by `real-registry.test.ts`. | `packages/ai/src/injection/injection.test.ts` | None after this task. | None. |
| F-07 | LOW (test debt) | Two existing pgTAP tests depend on the calendar date and fail with `--no-reset` on a clean tree: `303_message_flags` test 11 (fixtures dated Nov 10 against "last 14 days"; failing since Nov 24) and, once, `110_raw_source_records` test 191. Not caused by this task. | `supabase/core/supabase/tests/303_message_flags.test.sql:57` | The pgTAP run reports a failure that is not a defect. | Make the fixture dates relative to `now()`. |
| F-08 | INFO | `POST /api/webhooks/microsoft?validationToken=...` answers without any credential by echoing the token (at most 1,024 characters, `text/plain`, nosniff), as Microsoft's handshake requires. Tested; no impact. | `packages/connectors/src/webhooks/microsoft.ts` | None. | None. |

## 5. What could not be tested here, and what a person must do

These need a browser, a hosted project, a live provider or a database reset, which this run was not allowed to use.

1. **Hosted Supabase settings.** In the hosted project's dashboard (Authentication): confirm "Allow new users to sign up" is OFF, e-mail OTP length 6 and expiry 600 s, and the rate limits for sending and verifying codes are on (these back F-02). Confirm MFA (TOTP) is enabled. Compare with `supabase/core/supabase/config.toml` (the file's `[auth.email] enable_signup = true` line is for the local code flow; production must have new accounts impossible).
2. **Response headers in production.** Open the portal in a browser, DevTools, Network, click the document request: check for `strict-transport-security`, and note the absence of `content-security-policy` and `x-frame-options` (F-01). After the fix, check again, and try to embed the portal in a test page on another origin: it must refuse.
3. **Cookies.** In DevTools, Application, Cookies: the session cookies must be `HttpOnly`, `Secure` and `SameSite=Lax`.
4. **Inngest signing.** In Vercel (Production environment variables) confirm `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` are set and `APP_ENV` is not `local`. From a machine outside the company, `GET https://portal.pub-k.org/api/inngest` must not list the functions without a signed request (the code sets `enableUnauthedSync: false`).
5. **Real provider signatures.** Intuit: in the Intuit developer webhook page, send a test notification and check the portal queues it; then resend with a wrong verifier token in a staging copy and check 401. Microsoft: create a subscription in staging, then post a notification with the right `subscriptionId` and a wrong `clientState` to the staging endpoint and check it queues nothing.
6. **Real approval, end to end.** In staging with a throwaway mailbox and a throwaway Teams account: propose, approve with a fresh authenticator code, confirm one message is sent; try to approve again (refused); change `approvals_live` to false in a new lane config version and confirm approve is refused; remove the policy class and confirm the same. This is the live-provider half of what pgTAP `338` proves in the database.
7. **Full database reset run.** A person runs `pnpm test:db` (with reset) on a spare machine, because this run could only use `--no-reset` and a reset wipes the local live connection state.
8. **Real-model injection run.** `INJECTION_REAL_MODEL=1 pnpm test:injection` with the Anthropic variables set on a developer machine (the suite is scripted by default).
9. **Production state.** `core.lane_policies.write_actions_allowed` and `approvals_live` for PKG in production should match what the owner expects (a read-only query; the immediate off switch for any write path is `approvals_live` false in a new `lane_config` version).

## 6. What a passing suite does and does not prove

It proves that the rules written into the database policies, the function checks, the route guards, the approval gates and the redaction layer
behave as intended on synthetic data, and that a new table, function, route, provider or action type cannot be added without being looked at.

It does not prove: that the production database has the same migrations and settings as the local one (section 5, items 1 and 9); that the live
providers behave as their mocks do (signatures, token shapes, message delivery); that no vulnerability exists in code paths the suite does not
enumerate (for example a new library, a browser-side flaw, a flaw in Supabase, Vercel or Inngest themselves); that people use the system safely
(phishing, a stolen unlocked device, a shared authenticator); or that a real model will never be persuaded by hostile text (the suite proves what the
SERVER does when it is: nothing beyond two read tools, and no write without a human's approved exact content). Static checks (route inventory, console
sites, call-site lists) prove that guards are present in source, not that they are correct; the behaviour tests listed in the plan cover that for each guard.

## 7. How to run it

- Everything the suite adds also runs in the normal commands: `pnpm test` (vitest files and the manifest check `scripts/security-suite.test.mjs`) and `pnpm test:db` (pgTAP).
- The vitest half on its own: `pnpm test:security`. With the pgTAP half (no reset): `pnpm test:security -- --db`, or `export PATH="$PATH:$(ls -d ~/.nvm/versions/node/v24*/bin | head -1)" && node scripts/test-db.mjs --no-reset`.
- The list of suite files is `scripts/security-suite.json`; a `*security*` pgTAP file that is not listed fails `pnpm test`.
- Expected failures (`it.fails`) carry the finding id; when a finding is fixed its test fails loudly: remove `.fails`.

## 8. Runs on the final tree

| Run | Result |
|---|---|
| `pnpm typecheck` | 18 of 18 tasks pass |
| `pnpm lint` | all packages and `scripts` pass (web lint re-checked on the new test files) |
| `pnpm test` | pass: web 2,354 passed, 2 expected failures (F-01, F-02), 3 skipped; connectors 2,976 passed, 8 skipped; ai 186 passed, 15 skipped; approvals 251; brain 273; eslint-plugin 503; root node tests 219 pass, 0 fail |
| pgTAP, `node scripts/test-db.mjs --no-reset` | 77 files, 4,387 assertions; all five new files pass (334 to 338); one existing failure, `303_message_flags` test 11 (date-dependent fixture, F-07), not part of this change |
| `pnpm --filter @nichols/web build` | passes |
