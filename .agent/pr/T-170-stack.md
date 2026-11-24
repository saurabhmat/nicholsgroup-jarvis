# Security test suite, the header fix it led to, and backlog notes (T-170, T-299, D-71)

This pull request carries three stacked pieces. Each has its own full description in the repository.

| Piece | What | Full description |
|---|---|---|
| Backlog notes | Decision D-71 (approvals went live for the pilot company on Nov 24, 2026), switch-on results for Teams sending, merged Teams tasks marked done | `docs/backlog.md` |
| T-170 | The pilot security test suite and its report | `.agent/pr/T-170.md`, `docs/security/pilot-test.md` |
| T-299 | Response headers against framing and content sniffing (finding F-01 of the suite) | `.agent/pr/T-299.md` |

## What changes in the product
Only T-299 changes product code: `apps/web/next.config.ts` (three header rules) and one string in `apps/web/lib/teams-api.ts`. Every response now carries `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`; the Teams image route and the OAuth connect routes keep their own stricter values. Everything else is tests, two scripts (`pnpm test:security`) and documents. No SQL, no setting, no dependency.

## The verdict of the suite
No BLOCKER and no HIGH finding was found. The one MEDIUM (F-01, missing anti-framing headers) is fixed in code by T-299. LOW findings are listed in `docs/security/pilot-test.md` section 4. An independent reviewer ran mutation checks against the suite twice (it broke the product on purpose in rolled-back transactions and scratch edits); the suite was strengthened until those were caught, and the report says which properties are proven by which tests and what a passing suite does not prove.

## Checks
- T-170 (test engineer's runs on its final commit): typecheck, lint, the web build, pgTAP without reset (78 files, 4,416 assertions, all passing), `pnpm test:security`, and `pnpm test` run package by package (the single run exceeds this machine's time limit); all passing, with the pinned expected failures named in the report.
- T-299 (lead agent's runs on its final commits): web typecheck and lint, the web build (the three rules seen in the built route table), the root script tests (221 of 221), `pnpm test:security`, the header tests (24 passing, 1 expected failure for the unrelated finding F-02). One full web test run on the first T-299 commit: 2,396 passed, 1 failed (`components/reply-drawer.test.tsx`, a timing flake that passes alone, diagnosed in `docs/plan-review.md`).
- Not run anywhere: a browser, a database reset, the end-to-end suites, anything live against a provider.

## Needs a human after the deploy
1. Browser check of the headers on a page, an API response and one Teams chat picture (`docs/security/pilot-test.md` section 5, step 2).
2. Confirm in the hosted Supabase project that the MFA verification-attempt hook is enabled (step 10).
3. The other numbered steps of section 5, as time allows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
