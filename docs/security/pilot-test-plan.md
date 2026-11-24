# T-170 pilot security test: plan (phase 1, inventory)

Written Nov 24, 2026 from the code and the local database catalog, not from the backlog. Approvals went live for PKG on Nov 24 (D-71)
before this suite existed, so this checks a live system.

## 0. Early observations (none is a BLOCKER or HIGH on inspection)

| id | sev | what | where |
|---|---|---|---|
| F-01 | MEDIUM | No CSP, no frame-ancestors / X-Frame-Options, no nosniff, no HSTS set by the app (only Referrer-Policy). Clickjacking of the Approve button is limited by SameSite=Lax cookies and the TOTP step-up, so not HIGH. | apps/web/next.config.ts:18-20, packages/core/src/auth/client.ts:11 |
| F-02 | LOW | The wrong-code counter of the e-mail sign-in lives in an unsigned client cookie (`signin_pending.attempts`); deleting it resets it. Real limits are Supabase's OTP limits; AAL1 reaches no data (RLS needs AAL2). | apps/web/app/sign-in/actions.ts:15-58 |
| F-03 | LOW | The lane policy class list (`write_actions_allowed`) accepts `calendar`, `monday`, `notion` but no action type, executor or SQL gate exists for them: a lane that lists them gets nothing. `google.revoke_grant` has a connector writer (`googleWriter`) but no DB action type, so it is unreachable. | supabase act.is_allowed_type; packages/connectors/src/google/writer.ts:22 |
| F-04 | LOW | Stripe, GoHighLevel, monday, Notion, timesolv exist only as provider names (contract/schemas.ts:14); there is no connector, webhook or executor for them. Rule 8 and "webhook per provider" are therefore not testable for them. | packages/connectors/src/contract/schemas.ts |
| F-05 | LOW | About 40 `console.*` call sites in app code bypass the redacting connector logger. | see section 3 |
| F-06 | LOW | The injection suite (packages/ai/src/injection) runs against its own fake tools (read_email, get_mrr, prepare_email_send ...), not the two real tools (`list_recent_mail`, `list_meetings`). | injection.test.ts:100-150 |

Hosted-project settings (sign-up disabled, OTP limits) cannot be read from here: human check (section 8).

## 1. Database isolation

Catalog (local DB): 8 app schemas + `public` (empty); 45 tables, 1 view (`core.lane_config_current`, security_invoker). 44 tables have `lane_id`;
`core.lanes`, `core.users`, `core.mfa_*` do not (reviewed list). RLS on for all 45. API exposes `public, graphql_public, core, audit` only.
268 functions in app schemas, all owner postgres, **all with a pinned search_path**, none executable by `anon`.
`authenticated` can run 92 (37 SECURITY DEFINER, 55 invoker; 74 take `p_lane`); `service_role` 142; 71 are internal only.

`050_catalog.test.sql` (20 assertions) proves conventions from the catalog: lane_id present, RLS on, one standard SELECT policy with the AAL2 conjunct
(text compared), no write policy outside a list, no DML grants to authenticated, anon has nothing, views are security_invoker, every function pins
search_path, anon cannot execute, definer functions and authenticated-callable functions are on reviewed lists, stale list entries fail.
It does NOT prove that a user of lane A gets nothing from lane B, nor that another user in the same lane cannot read owner-only rows; those
behaviours are only proven table by table in the numbered tests (found by grep: every table is touched by at least one `set role authenticated` test;
`act.execution_claims`, `core.sync_now_requests`, `core.ai_*_rate`, `core.job_failures`, `brief.news_digests` have a single file each).

Phase 2: `340_isolation_catalog.test.sql` (new). A registry (temp table in the test) maps every app table and every authenticated-callable function to a
behavioural probe; the test fails when the catalog holds a subject without an entry, or an entry without a subject. Probes run as a PKG persona
(AAL2), an APK-only persona, an AAL1 session and a same-lane other user. Size: L.

## 2. Authentication, AAL2, step-up (routes)

31 `route.ts` handlers (some with several methods), 20 `page.tsx`, 4 server-action files (sign-in, mfa, briefing-actions, news-actions), `proxy.ts`,
Inngest endpoint, 2 webhook endpoints, 4 OAuth routes. Existing static catalog tests: `lane-pages.test.ts`, `module-gate-pages.test.ts` (pages),
`step-up-callers.test.ts` (callers of requireStepUp), `directive-exports.test.ts`. No catalog for API routes.
Phase 2: `apps/web/tests/route-inventory.test.ts`: walks `app/` for route.ts, page.tsx and `"use server"` files, and compares with a classification
table (auth: session / aal2 / lane / role / module gate / step-up / same-origin on state change / public with reason); fails on an unclassified or stale
entry; also asserts by source scan that each route or its named handler library calls the guard and origin check the table claims. Size: M.

## 3. Tokens and secrets

`getToken`/`reveal` are used in 22 production files, all under packages/connectors (ESLint `no-restricted-names` + `no-vault-access` enforce this).
Existing: `vault/canary.test.ts` (SecretValue, logger, ConnectorError), many per-connector tests that plant canaries. Missing: one harness over every
provider and every sink. Phase 2: `packages/connectors/src/vault/canary-sinks.test.ts` (provider registry from `PROVIDERS` and the connector dirs; fails on a
provider without an entry) plus `apps/web/tests/console-sites.test.ts` (scan for `console.*` in non-test files against a reviewed list). Size: M.

## 4. Webhooks

Registered: QuickBooks (`/api/webhooks/[provider]`, HMAC, no timestamp, dedupe by claim), Microsoft Graph (`/api/webhooks/microsoft`; mail, calendar, Teams
share it; no signature, per-subscription `clientState`, lane from the stored row), Inngest signing (`/api/inngest`). Google push: none. Stripe, GHL: none.
Existing: handler.test, quickbooks.test, microsoft.test, microsoft-teams.test, verifiers.test, route tests (behaviour tests with fakes), pgTAP 140.
Phase 2: `webhooks/spoofing-catalog.test.ts` enumerates `WEBHOOK_PROVIDERS` + the Microsoft handler and runs the same hostile set (no signature, wrong secret,
replay, oversize, wrong content type, event for another lane's account, content naming a lane). Size: M.

## 5. Prompt injection

Model call sites (5): assistant tool loop, reply draft (`lib/reply.ts`), briefing, news (web search), brain import. AI tools (2, both read): `list_recent_mail`, `list_meetings`.
Phase 2: `packages/ai/src/injection/real-registry.test.ts` runs a compliant mock model against the real registry and a registry-completeness check
(every registered tool has effect read or propose, strict args, trustedFields); plus a source scan that every `provider.complete` file imports the untrusted wrapper. Size: M.

## 6. External writes and approvals

Action types in the DB (`act.is_allowed_type`): `email.send`, `email.save_draft`, `qbo.disconnect`, `teams.chat.send`, `teams.channel.post`, `teams.channel.reply`:
6 with executors (email: Google + Microsoft writers; QuickBooks; Teams). Policy classes without any type or executor: `calendar`, `monday`, `notion`.
Existing: pgTAP 290/291/302/308/325/330/332 (real DB: hash mismatch, replay, double claim, role, step-up, live flag, policy, cross-lane, payload immutability)
and vitest for each executor (fake rpc). Boundary: ESLint `no-restricted-names` (30 names), `no-write-subpath-import`, `teams/write-boundary.test.ts`,
`google|microsoft/email-writer-boundary.test.ts`. Gaps: no catalog tying every action type to tamper tests; no proof that an allowed-but-executor-less class is inert.
Phase 2: `340`/`341` pgTAP (type catalog x gates) and `packages/modules/approvals/src/server/action-catalog.test.ts`. Size: L. "monday.com" cannot be tested (no action type): drop from the task text.

## 7. Rules 6, 7, 8, 11

Rule 6: no body/snippet columns in app tables except reviewed (`act.proposed_actions.payload` purged after use; `brief.briefings.content` is AI output). Rule 7: no write grant
on `fin.*` for authenticated; service-only functions. Both catalog tests in 340. Rule 8: not testable (no Stripe/GHL code).

## 8. Cannot be tested here

Browser runs (CSP, cookies, clickjacking), the hosted Supabase settings (sign-up off, OTP limits, MFA enforcement), live Microsoft/Intuit signatures and subscriptions,
`supabase db reset` based runs, production env keys (Inngest signing key set, `approvals_live` value), Vercel headers.

## 9. Build order, task text changes

1 approvals catalog (L), 2 route inventory (M), 3 isolation catalog (L), 4 webhooks (M), 5 token canaries (M), 6 injection (M), 7 report (S).
Drop "monday.com actions" (no such action type) and "report ... no open blocker/high" stays. Rename "webhook spoofing per provider" to the providers that exist.
