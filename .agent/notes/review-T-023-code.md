# Code review: T-023 (b872029)

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0. The Playwright specs (`e2e/zz-lane-shell-http.spec.ts`, `e2e/shell.spec.ts`) were not run: they need the local Supabase stack and Mailpit, and Chromium for the browser spec.

Verdict: no BLOCKER, no HIGH. Acceptance criteria are met. T-023 stays `approved` until the browser spec passes, which is honest and correct.

## BLOCKER
None.

## HIGH
None.

## MEDIUM

M1. `apps/web/lib/brand.ts:3` puts a company name ("Pub K") in code. This is against rule 2 (no company-specific code) and the file's own comment ("same in every lane") does not remove that.
- The shell is multi-lane by design, and a second brand is already likely (the docs mention Nichols Group).
- Fix: read the wordmark and product name from app config (for example `NEXT_PUBLIC_BRAND_WORDMARK` and `NEXT_PUBLIC_BRAND_PRODUCT`, validated in `apps/web/app/env-check`, with the design values as the pilot default in `.env.example`/Vercel env), or from a deployment-level setting.
- If the human accepts the constant, record that as a decision in plan-review. It is currently only an "L" note.
- Also, `BRAND.product` duplicates the string in `metadata.title` (`apps/web/app/layout.tsx:21`). Derive the title from the same source.

M2. Proxy placement of the lane check (`apps/web/proxy.ts:35-42`, `packages/core/src/auth/index.ts` `laneSegment`/`laneVerdict`).
- Every page request now does three lane lookups: the proxy (`requireLane`), then `loadLane` (`requireLane` + `listLanes`). Each is a JWT verify plus a `core.lanes` query. Already logged in plan-review.
- Fix (cheap): in `loadLane`, drop the separate `requireLane` call and decide from `listLanes()` alone. `listLanes` already applies RLS (member, AAL2, enabled), served list and data plane, which is the same rule `getLaneClient` uses. Keep `requireLane` only where a client is needed.
- That removes one query per request without weakening the gate.
- The proxy must stay as is, because the layout is wrapped in `<Suspense fallback={null}>` and a `notFound()` after the shell has streamed gives status 200. The proxy is what provides the real 404. Say this in a comment next to the Suspense in `[laneId]/layout.tsx`.

M3. The proxy treats every unknown first path segment as a lane (`NON_LANE_SEGMENTS` is an allow-list of non-lanes). A signed-in request for `/manifest.webmanifest`, `/robots.txt`, `/sw.js` or `/.well-known/...` gets a 404 and costs a DB query.
- Known and logged for T-025, but it is cheap to fix now by inverting the test: treat a segment as a lane only if it matches the lane code format (for example `/^[A-Z][A-Z0-9]{1,7}$/`).
- Lowercase `/pkg` then falls through to the page, which 404s but with status 200 once streaming has begun.
- If that matters, keep the current deny-by-default approach and add the PWA files to the matcher exclusions in T-025. Add a unit test for `laneSegment` on `/manifest.webmanifest` either way. Today's tests only pin the current behaviour.

M4. Placeholder copy asserts something false before the module exists: `packages/ui/src/lib/nav.ts` (approvals entry) says "Nothing waiting for approval. Nothing is sent or changed until you approve it."
- In a real session an approver could read this as "the queue is empty". Use "Approvals are not set up yet" (the same pattern as the other entries), or keep the second sentence only.

## LOW

L1. `apps/web/app/page.tsx`, `Entry`: the AuthError mapping sends every non-`mfa_required` error to `/sign-in`, including `forbidden` (`listLanes` maps `LaneAccessError` to forbidden). A signed-in AAL2 user hitting that would bounce between `/` and `/sign-in`, if sign-in redirects signed-in users. Mirror `loadLane`: `no_session` to `/sign-in`, `mfa_required` to `/mfa`, anything else rethrow or show the "no company access" card.

L2. `/` redirects in-document with status 200 (already logged). Acceptable for a page behind auth. A `redirect()` in the proxy for the exact `/` path would make it a real 307, but this needs the lane list and it is not worth another query. Leave it.

L3. `packages/ui/src/lib/nav.ts`: `MOBILE_TABS[more].covers` and `MORE_ITEMS` list the same four keys by hand. Derive one from the other (`covers: MORE_ITEMS`, defined first) so T-024 cannot change one and forget the other. The placeholder titles and descriptions also live in the nav table. That is fine for T-023, but T-024 should not have to touch copy. Consider moving them next to the placeholder component.

L4. `loadLane` call repeated: the layout, the nine pages and `More` all do `loadLane((await params).laneId)`. This is deliberate (a layout does not re-render on client navigation) and `cache()` dedupes it, so the cost is fine. Readability fix: a tiny `ModulePage`-style helper already exists. Use it for `more` and for home too, and add one comment in `lane-page.ts` that every new page under `[laneId]` must call it. A lint rule or a test that walks `app/[laneId]/**/page.tsx` and asserts `loadLane`/`ModulePage` is referenced would stop a future page from forgetting it (T-024 and the module tasks will add many).

L5. Theme.
- Pre-paint script (`packages/ui/src/lib/theme.ts` `THEME_INIT`, `apps/web/app/layout.tsx:36`): correct. It sets `data-theme` only for an explicit choice; `system` is handled by the media query in `theme.css`, so there is no flash. `suppressHydrationWarning` is on `<html>`, so no mismatch error. `color-scheme` is set in the token CSS.
- `ThemeToggle` uses `useSyncExternalStore` with server snapshot "system". After hydration the pressed state may flip once (a one-frame flicker of the control, not the page). Acceptable.
- It does not listen to the `storage` event, so a second tab does not follow. Optional.
- The inline script needs a nonce or hash if a CSP is added (logged).
- Add a unit test that `THEME_INIT` is syntactically valid and only reads `THEME_KEY` (`new Function(THEME_INIT)` in a jsdom-like stub). The existing theme tests cover `applyTheme`/`readTheme` but not the script text.

L6. `[laneId]/layout.tsx`: `<Suspense fallback={null}>` around the whole shell shows a blank page until auth and lane lookups finish. A skeleton shell (navy sidebar only) as the fallback would feel faster. Optional.

L7. Tests.
- Unit tests for `listLanes` mock the Supabase builder, so they prove the router's own filtering and error handling but not RLS. That is fine, because the real RLS behaviour is covered by the HTTP spec on the real stack. The unit test for the "outage is not an empty list" case is good.
- The HTTP spec does prove the acceptance criterion without a browser: the member sees only PKG and gets 404 for `/APK`, `/NL`, `/PKI`, `/pkg`, `/ZZZ`, and the lane-less user gets the same 404 for `/PKG` as for `/ZZZ`. It is not vacuous, because the 404 and the absence of "Pub K Group" in the body are both asserted and the outsider case isolates membership from the enabled/served filter.
- Gap: with only PKG enabled, "member of an enabled lane that is not theirs, while another enabled lane is theirs" is not exercised end to end. Unit tests cover the filter. Accept, or add a second enabled lane to the e2e stack later (ENABLED_LANES=PKG,APK with a persona that belongs only to PKG).
- The `/` assertion regex (`url=\/PKG\b|NEXT_REDIRECT...`) is loose. Prefer asserting that following the redirect lands on `/PKG`.
- Fragile points in the spec: the hard-coded port 3100 (take it from the Playwright config `baseURL`), reliance on the `zz-` file name for ordering, and a 30 s sleep per persona in `api-session.ts` when the authenticator already exists. It works, but document the ordering dependency in `playwright.config.ts` or make `aal2Cookie` enrol its own factor.
- No test of `proxy.ts` itself (cookie and cache-control propagation on the 404). Optional.

L8. Scope. Light/dark and Projects are in scope per the Nov 4 note. The `api-session.ts`, `e2e-reset.mjs` change (reads the local publishable key via `supabase status`, public by design, not printed) and the edits to `mfa.spec.ts` and `step-up.spec.ts` are test support for this task. No unnecessary dependencies were added. The nav table is data-driven (`NAV_ITEMS`, `MOBILE_TABS`, `MORE_ITEMS`), so T-024 is small: it edits one file and its test.

L9. Next.js 16 conventions: `proxy.ts` (not middleware), async `params` via `PageProps`/`LayoutProps`, `connection()` plus `cacheComponents: true` with Suspense boundaries, server components for pages, one `"use client"` shell for `usePathname`. All correct. `Link` is passed to the presentational `AppShell`, which keeps `packages/ui` free of `next`. Good separation.

L10. Process: the PR note says `security-reviewer` and `code-reviewer` could not be run from the build session. This review covers code quality. A security review of the proxy refusal path, `listLanes` and the rule-1 router change is still required before done (this is RLS/data-access code, so full review depth applies).

## Design record check
Nav order, the iPhone tabs (Home, Approvals, Inbox, Ask, More), no back link on tabs, no "All companies", Search and Commitments hidden (404 tested), `data-theme` light/dark: all match `docs/design/README.md`.

## Required before done
1. Run Chromium deps and `pnpm test:e2e` (`shell.spec.ts`).
2. Run security review on the commit.
3. Decide on M1 (brand constant): move to app config, or record the accepted exception in plan-review.
4. Fix M4 (false "nothing waiting" copy) and L1 (sign-in loop on forbidden); both are one-line changes.
