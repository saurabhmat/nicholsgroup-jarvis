# Security review: T-024 navigation and page structure (commit 7501beb)

Reviewer: security-reviewer subagent, Nov 4, 2026. Scope: `git show 7501beb` against CLAUDE.md rules 1-13,
`.agent/pr/T-024.md`, plan-review §6 (T-023, T-024), `.agent/notes/review-T-023-security.md`.
`pnpm exec vitest run` in apps/web: 5 files, 39 tests pass. Playwright not run.

**Verdict: no BLOCKER, no HIGH.** 2 MEDIUM, 6 LOW.

## What was verified (no finding)
- **The proxy is still not the gate, and no path reaches lane data without `loadLane`.** Every rendered `[laneId]`
  page and the `[laneId]` layout call `loadLane(param)` -> `requireLane` -> `getLaneClient`, which applies
  `LANE_ID = /^[A-Z]{1,8}$/` (no `i`/`u`/`m` flags; JS `$` is end of input, so `PKG\n` fails), the served list,
  the RLS `core.lanes` row (member, AAL2, enabled) and `forPlane`. `loadLane` also needs an exact `===` match in
  `listLanes`. Narrowing `laneSegment` changes only whether the proxy sends a 404 status before streaming. It does not
  change access.
- **Dotted / encoded / folded segments** (I simulated laneSegment with WHATWG URL parsing):
  - `/%2E/PKG`, `/.%2E/PKG/finance` and `/%2e%2e/APK` become `/PKG` and `/APK` in the URL parser before the proxy
    runs, so they are checked as `PKG` and `APK`.
  - `/PKG.`, `/PKG.json`, `/PKG%2E` and `/APK;.x` skip the proxy check. Next then passes `PKG.`, `PKG.json` and so on
    to `loadLane`, which fails `LANE_ID` and gives 404 UI. Next does not strip a trailing dot or extension from a
    dynamic param, so no dotted segment decodes to a canonical code.
  - Fullwidth `ＰＫＧ` (`%EF%BC%B0KG`) and the ideographic full stop (`%E3%80%82`) have no ASCII dot, so they go to
    the lane check and get 404. No Unicode folding happens anywhere: the regex has no `i`/`u` flags and comparisons
    use `===`.
  - `/%50KG`: the proxy checks the raw `%50KG` (refused). Next decodes the param to `PKG`, so for a member the page
    serves PKG. That is correct: the page's own check runs on the decoded value, and a non-member gets 404 from the
    page.
  - A malformed encoding falls back to checking the raw segment (fail closed).
  - `/PKG.rsc`: Next's middleware adapter (`normalizeRscURL`, next 16.4.2 `dist/server/web/adapter.js:106`) strips
    `.rsc`, so the proxy sees `/PKG` and checks it.
- **404 headers** (`apps/web/proxy.ts:43-45`): `private, no-store` and `vary: cookie` are set every time. Refreshed
  cookies are still copied over. The body is constant and has no lane name. The unit test asserts this even when the
  session was not refreshed.
- **XSS**: there is no `dangerouslySetInnerHTML` in any new component. The only use is still the constant
  `THEME_INIT` in `app/layout.tsx:35`. `firstName`, `lane.name`, eyebrow, title and accent are rendered as JSX text
  (escaped). `homeHeading` trims the name. `TabIcon` paths are constants keyed by a typed union. The `Ask Jarvis` href
  uses the verified `lane.laneId`.
- **format-date**: pure `Intl` formatting in America/New_York (rule 11). It runs after `connection()` in `loadLane`,
  so there is no prerender or cache issue. No user input.
- **Vitest in apps/web**:
  - Only the `server-only` alias, pointed at an empty stub, and `@`.
  - Node environment. No `.env` loading or `loadEnv`, and no `process.env` use in the tests (Vite exposes only
    `VITE_`-prefixed variables, and only to `import.meta.env`). There are no `.env*` files in apps/web, and turbo's
    `test` task has no `env` passthrough.
  - All auth and guard boundaries are mocked (`@/lib/guards`, and `refreshSession`/`laneVerdict`/`createGuards` in
    the proxy test), so no network or DB is reached.
  - Mock data is synthetic (rule 10).
  - The `server-only` stub applies only under vitest and does not change the Next build.
- **Dependency allowlist**: `vitest` 5.0.5 is a devDependency of `apps/web`, the same version the root and connectors
  already use. It is not a vendor/network/DB SDK, so no `no-vendor-sdk` boundary changes.
- **mfaPath** move: unchanged logic. The caller still runs `safeNextPath` first, and the tests cover `//evil.example`
  and `https://evil.example/`.
- **Rules**:
  - Rule 1: pages take `laneId` from the URL and use only the verified value.
  - Rule 4 / rule 5 / rule 9: nothing here applies. There are no connectors, external writes, tokens, prompts or
    retrieved content.
  - Rule 6: nothing is stored.
  - Rule 7: Cash carries `bookBalance` and the text "Book balance". There are no figures.
  - Rule 12: no production access.
  - Rule 3: no SQL.

## MEDIUM

### M1. The static "every page reaches loadLane" test has gaps that would pass a page or route that skips it
`apps/web/tests/lane-pages.test.ts:13, 24, 26, 43-45`
- **Scenario A, file kinds.** Only files named exactly `page.tsx` are collected (line 13). A future
  `app/[laneId]/export/route.ts` is never examined, and neither are `page.ts`/`page.jsx`, `default.tsx` (parallel
  routes), `template.tsx`, `loading.tsx`, metadata routes (`opengraph-image.tsx`, `icon.tsx`) or nested
  `layout.tsx`. Route handlers matter most: they do not render the `[laneId]` layout, so `loadLane` in the layout does
  not protect them. A route handler that reads lane data without `requireLane` would pass this test.
- **Scenario B, false positives.** `/\bloadLane\s*\(/` also matches a comment (`// TODO loadLane(...)`), a string,
  or a call whose argument is not the URL param (`loadLane("PKG")`). It also counts any imported `@/components/*`
  module that calls `loadLane`, even one imported only for a type or a helper while the page renders something else
  (line 26).
- **Exposure today: none.** All 9 pages call `loadLane((await params).laneId)` directly or through
  ModulePage/HomePage/FinancePage/ApprovalsPage, and any DB read must still go through `getLaneClient` + RLS. This is
  defence in depth that is weaker than the PR body claims ("A new page that skips it fails here").
- **Fix:**
  1. Walk every file under `app/[laneId]` and fail on any file whose name is not in an explicit allowlist (`page.tsx`,
     `layout.tsx`). Adding `route.ts`, `default.tsx` or another kind should force the author to extend the test with
     a matching rule. For `route.ts`, require `requireLane(`/`requireRole(` on the URL param and a 404/403 test.
  2. Strip comments before matching, or better, use an AST/ESLint rule (packages/eslint-plugin already exists) that
     requires a `loadLane(<params>.laneId)` call in the default export's render path.
  3. Assert that every nested `layout.tsx` calls `loadLane` as well, not only the root `[laneId]/layout.tsx`.

### M2. The e2e assertion for root files cannot pass as written, and it does not tell the two 404 bodies apart
`apps/web/e2e/zz-lane-shell-http.spec.ts:49` vs `apps/web/app/not-found.tsx:8` and `apps/web/proxy.ts:16`
- **Scenario.** For a signed-in user, `/robots.txt` now reaches `[laneId]`. `loadLane("robots.txt")` calls
  `notFound()` and the app's `not-found.tsx` renders. That page shows exactly the sentence the spec says must be
  absent: "This page does not exist, or you do not have access to it." The proxy body uses the same sentence. So the
  spec fails on a correct build. Worse, if someone "fixes" it by changing the app copy, the test still only checks
  wording and not which layer answered. This is a test-correctness issue, not an exposure. The builder did not run the
  browser suite.
- **Fix.** Make the two bodies distinguishable by something structural:
  - Assert that the dotted response includes `/_next/` (an app-rendered page) or does NOT include
    `<meta name="robots" content="noindex">` in the exact proxy form.
  - Or have the proxy 404 set a marker header, such as `x-lane-check: denied`, that the spec asserts is absent for
    root files and present for `/pkg` and `/%50KG`.
  - Also assert that no lane name appears in the dotted responses.

## LOW

### L1. A dotted first segment skips the proxy status check, including Next's internal segment-prefetch aliases
`packages/core/src/auth/index.ts:180-187`
- **Scenario.** In minimal mode (Vercel deployments, including previews), the request
  `/APK.segments/_tree.segment.rsc` passes through the proxy as follows:
  1. The adapter strips the trailing `.rsc`, giving `/APK.segments/...`.
  2. `laneSegment` sees `APK.segments`, which contains a dot, returns `null`, and the proxy skips the lane check.
  3. `base-server` (minimal mode, `segmentPrefetchRSC` normalizer) then serves the `/APK` segment prefetch.
- **Effect.** The proxy's pre-stream 404 is skipped for a lane the user cannot open. Data is still safe: the layout
  and page call `loadLane("APK")` and the `[laneId]` layout's Suspense fallback is `null`, so the shell has no lane
  data. There is no existence oracle either, because unknown, disabled and not-yours lanes all give the same
  `notFound`. Before this change the request got a proxy 404 (`APK.segments` was denied). The PR rule "only the
  canonical code is a lane, everything else is refused" is broader than needed: "any decoded dot passes" also lets
  `/PKG.json`, `/PKG.` and similar through as soft 404s.
- **Fix.** Replace the "contains a dot" rule with an explicit allowlist of root files that are not lanes
  (`robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `.well-known`, `apple-touch-icon*`, `icon*`), checked on the
  decoded segment. Every other non-canonical segment, including any segment whose part before the first dot matches
  `LANE_ID`, goes to the lane check (404). Add `/PKG.json`, `/PKG.` and `/APK.segments/_tree.segment` cases to
  `auth.test.ts` and `proxy.test.ts`.

### L2. Soft 404 with status 200 for dotted paths
- **Scenario.** `/robots.txt` and `/PKG.json` (signed in) stream the app's not-found UI under the `[laneId]` Suspense
  boundary, so the status may be 200. Crawlers and monitors see a 200 HTML page for `robots.txt`. This is already
  logged in plan-review for T-025. It is not an exposure: the dynamic render is `private, no-store`.
- **Fix.** Covered by L1's allowlist, plus real `app/robots.ts` / `app/sitemap.ts` / `app/manifest.ts` in T-025.
  Static routes take precedence over `[laneId]`.

### L3. The `text-gold` exception matches by suffix
`packages/ui/src/styles/tokens.test.ts:214`
- **Scenario.** `String(file).endsWith("app-shell.tsx")` also lets a future `mobile-app-shell.tsx` or
  `x-app-shell.tsx` use one raw `text-gold`. `sources()` (line 23-28) lists top-level file names only, so equality is
  exact enough.
- **Fix.** Compare with `file === "app-shell.tsx"`. Optionally also assert that the single use sits inside the
  `data-slot="mobile-title"` element, for example by rendering it and checking that `text-gold` appears only on
  `[data-slot=mobile-title] em`. That part of the check is already in `page-parts.test.tsx`.
- **Note (pre-existing).** `sources()` does not scan `apps/web/components/*`, so app-level components are not held to
  the token, raw-gold or HTML-injection rules at all. Consider extending it.

### L4. Accounting and source vendor names are hard-coded in the Finance page copy
`apps/web/components/finance-page.tsx:12, 18, 21` ("Per QuickBooks, not the bank", "Revenue: Stripe · Subscribers:
GoHighLevel", "Book balance, per QuickBooks")
- **Scenario.** Rule 2 says each lane's systems live in `lane_config`. A second lane on a different ledger or
  subscriber system would show the wrong source label. Rule 8 fixes Stripe/GHL as the sources of truth, and these are
  placeholders, so this is low.
- **Fix.** When T-095 adds figures, derive the source chip and label from the lane's connector/lane_config record.
  Until then, use neutral copy ("Book balance, per the accounting system").

### L5. Redirect responses do not carry `private, no-store`
`apps/web/proxy.ts:57-58` (pre-existing)
- **Scenario.** The sign-in/MFA 307 copies `cache-control` only when Supabase set one. 307 is not heuristically
  cacheable, so the risk is minimal. It is just inconsistent with the new 404 handling.
- **Fix.** Set `cache-control: private, no-store` and `vary: cookie` on the redirect too.

### L6. The proxy unit test asserts `vary` with `toBe("cookie")`
`apps/web/tests/proxy.test.ts`
- **Scenario.** This is fine today. If a later change appends (`vary: cookie, rsc`), the unit test breaks while the
  e2e uses `toContain`.
- **Fix.** Use `toContain("cookie")` in both.

## Not a finding
- `firstName` has no source yet (logged in Needs human). When it is added, it must come from the user's own profile
  row under RLS, not from `user_metadata` set by the client. React escaping already handles injection.
- `PeriodToggle` is a client component with UI state only. It makes no network calls and has no URL-param injection.
