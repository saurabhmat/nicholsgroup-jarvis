# Code review: 7501beb (T-024 + T-023 follow-ups)

Checks: `pnpm typecheck && pnpm lint && pnpm test` pass (exit 0); `node --test scripts/*.test.mjs` 138/138 pass. e2e not run (port 3100 busy, per the PR).

## BLOCKER
None.

## HIGH
None.

## MEDIUM
1. iPhone Approvals band deviates from prototype p7. app-shell.tsx:109-117 / nav.ts `pageHeading` uses the desktop heading, so the band says "Approvals waiting for you". The p7 band says "Approvals" with a sub-line "3 waiting · Pub K Group". Fix: give nav items a separate `mobileHeading` (or accent omitted on mobile) and render the lane name as the sub-line on non-Home tabs. Update the e2e/ui test that pins "Approvals waiting for you" in the band (page-parts.test.tsx).
2. iPhone Home: the prototype puts the date line inside the navy band (above "Good morning"), here it sits in the page body (home-page.tsx eyebrow) under the band, so the mobile layout is band(chip, title) then date on cream. Fix: render the eyebrow in the band on mobile (or pass an optional `bandSubtitle` to AppShell). Same cause as 1.
3. Heading text is duplicated: nav.ts `heading` and the page props (finance-page.tsx `title="Finance" accent="at a glance"`, approvals-page.tsx `"Approvals"/"waiting for you"`). The band and the H1 can drift (the band is aria-hidden, so nothing catches it). Fix: pages read `navItem("finance").heading` as ModulePage already does; add a test that each page title equals the nav heading.
4. Scope: the commit also changes the proxy, `laneSegment` in core, `LANE_ID` export, `mfaPath` move and adds a Vitest runner and dependency. All are logged as T-023 follow-ups and tested, but T-024's acceptance is only "navigation and page structure". Not worth splitting now; keep them named in the PR (they are). Security reviewer should look at `laneSegment` returning null for any dotted first segment (core/src/auth/index.ts:~181): the proxy then skips the lane check and only the page gate protects it. Safe today (loadLane rejects non-canonical ids), but note the "/PKG." case is covered only by the page gate, so add a page-level test for a dotted id.

## LOW
1. home-page.tsx:12 and nav.ts: "Good morning" is hard-coded for all hours. Use a time-of-day greeting in America/New_York or just "Hello"; at minimum log it.
2. Mobile Finance/other eyebrows (finance-page.tsx:10) repeat the company name already shown in the band chip. Hide the eyebrow below md or accept.
3. e2e shell.spec.ts: `getByText("Pub K Group").first()` and `getByText("Book balance").first()` are weak (any match passes). Scope them to the eyebrow (`[data-slot=page-eyebrow]`) and to the Cash card (`[data-slot=kpi-card]`). The sr-only H1 counts as "visible" to Playwright, so the mobile H1 assertions do not prove the visual title; the band assertion does cover it.
4. e2e zz-lane-shell-http.spec.ts: the root-files loop asserts only a negative (not the proxy 404 body). Add a status assertion once the real behaviour is confirmed in a live run (PR already flags it).
5. lane-pages.test.ts reachesLoadLane follows only `@/components/<x>` imports with a regex; a component imported through a barrel or another alias is a false failure (safe direction). Fine. The "finds >= 9 pages" count is brittle; consider a list of expected routes.
6. PeriodToggle (period-toggle.tsx) is client state only, so the cards say "For the selected period" while nothing changes. Acceptable as a placeholder; T-095 must wire it (URL search param is better than state, so it survives reload and is server-readable).
7. KpiCard labels "Cash" + Book balance label: the design README says "Cash (book balance)"; the label chip satisfies rule 7. OK. "Net income" lacks the "· month to date" wording; it depends on the toggle, so fine.

## Checked and fine
- Structure vs prototype: desktop Home/Finance/Approvals header eyebrow, serif H1 with italic accent, section titles (Today's briefing, Needs your attention, Today's meetings, Projects at a glance, Subscriptions, Receivables aging, Cash by account, Controls, Reports, Waiting for you), "Ask Jarvis" link to assistant, period labels exactly "This week (Sat–Fri) / Month to date / Year to date", "book balance" wording (Cash card, "Cash by account" note), tab icons present, aria-hidden, no back link. Desktop Approvals "Approvals waiting for you" matches p5.
- Placeholders: only EmptyState text, no figures, no "Sample data"; KpiCard falls back to "No data yet". Page-section test asserts no "sample data".
- text-gold exception (tokens.test.ts:210-214): narrow (file name + exactly one use), justified (band navy in both modes, README allows gold text on dark grounds). Weakness: it checks count, not that the use is the band accent; acceptable. Contrast of gold on navy band is fine.
- Mobile hidden H1 + aria-hidden band title: sound (one heading in the a11y tree, sighted users see the band title; `md:not-sr-only` restores the H1 on desktop). Caveat: H1 hidden on mobile means the visible title is not a heading for sighted-only users, which is fine. Keep the two strings in sync (MEDIUM 3).
- Server vs client: PageHeader/PageSection are server-safe; only PeriodToggle is `"use client"`. Pages await `params` inside Suspense and call loadLane first, per Next 16 conventions. `new Date()` in HomePage runs after awaiting params, inside Suspense: fine.
- Tests are meaningful: loadLane covers allowed, unlisted, forbidden, no_session, mfa_required, outage propagation (not 404), other auth errors; landingPath/mfaPath cover deep link, no lane, outage, `//evil`. Proxy tests assert the no-store/vary headers and the lane verdict argument. ui render tests assert real DOM (aria-hidden, em accent, pressed state).
- Dependency: vitest 5.0.5 matches the workspace, allow-listed in the script test; no new runtime deps.
