# Security review: T-023 app shell (commit b872029)

Reviewer: security-reviewer subagent, Nov 4, 2026. Scope: `git show b872029` against CLAUDE.md rules 1-13, backlog T-023,
`.agent/pr/T-023.md`, plan-review §6 "T-023 app shell".

**Verdict: no BLOCKER, no HIGH.** 4 MEDIUM, 6 LOW.

## What was verified (no finding)
- **listLanes** (`packages/core/src/lane-router/index.ts:122-139`) uses the user's own client (publishable key + bearer).
  RLS `lanes_select` (migration `20261031041722`) requires `aal = aal2` and `code = any(core.allowed_lanes(auth.uid(), 'lanes'))`;
  allowed_lanes is own-uid / AAL2 / enabled-only (pgTAP 020, 030 cover non-member, AAL1, no-aal). The query also filters
  `enabled = true`, then intersects with ENABLED_LANES and `data_plane = 'core'`. `Guards.listLanes` additionally
  requires AAL2 before calling the router. A failed query throws (not an empty list). It cannot return a non-member,
  disabled, unserved, NL-plane or sub-AAL2 lane. It agrees with `getLaneClient` (same RLS row, same served list, same
  `forPlane` rule), and `loadLane` requires BOTH `requireLane` and membership of the listed set.
- **URL lane handling**: `loadLane` (`apps/web/lib/lane-page.ts:15-32`) is called by the layout and by every page
  (8 via `components/module-page.tsx`, plus `more/page.tsx`). `/pkg`, `/PKG;--`, `/ZZZ` fail `^[A-Z]{1,8}$`/served
  checks and give 404; `..` and trailing slashes are normalised by Next before routing. `notFound()`/`redirect()` thrown
  inside the `try` are re-thrown untouched (not AuthError). Outages are an error page, never access. The same 404
  body is served for unknown, disabled and non-member lanes; the HTTP spec checks that a non-member gets 404 for PKG
  and for ZZZ alike.
- **proxy.ts**: redirect targets are fixed (`/sign-in`, `/mfa`), `next` goes through `safeNextPath`; no open redirect.
  The lane check only turns a definite refusal into 404; anything else falls through to the page gate (fail closed at
  the page). Refreshed cookies are copied onto the 404 response.
- **Theme**: `THEME_INIT` (`packages/ui/src/lib/theme.ts:8`) is a compile-time constant; the only localStorage value it
  reads is compared against `"light"|"dark"` before use, so no injection from storage. `dangerouslySetInnerHTML` in
  `apps/web/app/layout.tsx:34` carries only that constant. Only the key `theme` is stored; no lane data.
- **e2e**: `api-session.ts` targets `http://127.0.0.1:54321` only, synthetic `@example.test` personas, prints only HTTP
  statuses (never codes, tokens or TOTP secrets). `e2e-reset.mjs` uses `db reset --local` and extracts only the local
  publishable key from `supabase status`, keeps it in process env, never prints it. No production target, no real
  credentials.
- Rules 3/5/6/7/9: no SQL, no external writes, no content storage, no AI, no figures in this change. Lane names render
  through React (escaped).

## MEDIUM

### M1. The page/layout gate has no test that runs without the proxy
- Where: `apps/web/lib/lane-page.ts:15-32`; `apps/web/e2e/zz-lane-shell-http.spec.ts:45-63`.
- Problem: every 404 assertion in the HTTP spec is answered by the proxy (`proxy.ts:40`) before the page runs. The
  plan-review decision (Oct 31) is that the proxy is not the gate, and plan-review §6 T-023 M1 even suggests dropping
  the proxy check. Nothing tests that `loadLane` itself refuses.
- Failure scenario: someone edits `loadLane` (for example drops the `lanes.find` or catches AuthError("forbidden") into
  a default) or a page is added that skips `loadLane`. All tests stay green because the proxy still answers 404; later
  the proxy check is removed for latency (as the log suggests) and non-member lanes render.
- Fix: add a Vitest unit test for `loadLane` with mocked `guards()` (forbidden -> notFound, no_session -> redirect
  /sign-in, mfa_required -> /mfa, outage -> rethrow, requireLane ok but lane not in listLanes -> notFound), and a
  static test that every `app/[laneId]/**/page.tsx` reaches `loadLane` (or `ModulePage`). Optionally an e2e case with
  the proxy check disabled by an env flag in the local server only.

### M2. Product brand hard-coded in code (rule 2)
- Where: `apps/web/lib/brand.ts:3` (`wordmark: "Pub K"`), used by `app/[laneId]/layout.tsx`.
- Problem: rule 2 says no company-specific code; "Pub K" is a company name shown in every lane, including future
  non-PKG lanes (APK, NL, PKI, personal). Logged by the builder as LOW.
- Failure scenario: when a second lane is enabled, a Nichols Law or personal lane is shown under the "Pub K" wordmark,
  which misattributes data to the wrong company in screenshots and on the iPhone app.
- Fix: read the wordmark from deployment config (env) or `lane_config` (per-lane brand with a default), or get an
  explicit human sign-off in plan-review §7 that the pilot brand is a product constant and not company config.

### M3. Proxy cost and auth-call amplification per page request
- Where: `apps/web/proxy.ts:29,40`; `packages/core/src/auth/index.ts:59-77,181-188`.
- Problem: each signed-in page request (including RSC prefetches of every nav link) now does `getClaims` in
  `refreshSession`, then `getSession` + `getClaims` + a `core.lanes` query in `laneVerdict`, then the page does it again
  (`requireLane` + `listLanes`). With a symmetric JWT secret `getClaims` calls the Auth server. The T-018 review already
  flagged the shared Auth rate-limit budget for server-originated requests.
- Failure scenario: a signed-in tab prefetching 8-9 nav links multiplies Auth calls; under load the shared Auth budget
  is exhausted and every user is sent to sign-in (availability, not confidentiality).
- Fix: reuse the claims from `refreshSession` for the verdict (pass the verified session instead of re-reading), skip
  the proxy lane check for prefetch requests (`next-router-prefetch` / `purpose: prefetch` header), confirm asymmetric
  JWT signing keys so `getClaims` verifies locally. Agree with the builder's log entry; keep it open.

### M4. Proxy treats every unknown first segment as a lane (wider than the logged root-file issue)
- Where: `packages/core/src/auth/index.ts:167` (`NON_LANE_SEGMENTS`), `apps/web/proxy.ts:64` matcher.
- Problem: besides T-025's `/manifest.webmanifest` and `/robots.txt`, anything under `/_next/` other than `static/` and
  `image`, `/.well-known/*` (e.g. `apple-app-site-association`, `change-password`), `/sitemap.xml` and future route
  groups are 404'd for signed-in users by the proxy. It fails closed (no leak), but it is a correctness trap that
  invites someone to loosen the check in a hurry.
- Fix: invert the rule: only treat a segment as a lane when it matches the lane-id shape (`^[A-Z]{1,8}$`) or is a
  near miss you want to 404; let everything else fall through to Next routing (which 404s by itself). Or extend the
  matcher to exclude `/_next/`, `/.well-known/` and dotted root files. Add a unit case for each.

## LOW

### L1. URL-encoded lane ids are handled differently by proxy and page
- Where: `proxy.ts:39` (raw `nextUrl.pathname`) vs `lane-page.ts:15` (Next-decoded `params.laneId`).
- Scenario: `/%50KG` -> proxy sees `%50KG` (invalid) and 404s; the page alone would decode to `PKG` and render the
  lane at a non-canonical URL (nav `activeKey` then matches nothing). Same user, same lane, so no leak; it only matters
  if the proxy check is dropped (M3/M1).
- Fix: in `loadLane`, 404 unless the raw segment is already canonical (e.g. compare against `^[A-Z]{1,8}$` before
  decoding, or redirect to `/${lane.laneId}`); add `/%50KG` to the HTTP spec.

### L2. Timing distinguishes served from unserved lane ids
- Where: `lane-router/index.ts:90-93` vs `:96-106`.
- Scenario: `/ZZZ` or `/APK` fail the in-memory served check without a DB round trip; `/PKG` for a non-member costs a
  query, so response time reveals which ids are in ENABLED_LANES. Lane existence in `core.lanes` is not revealed.
  Acceptable for an invite-only portal.
- Fix: none required; document as accepted, or always run the RLS query.

### L3. The proxy 404 is not marked private/no-store
- Where: `proxy.ts:41-44`.
- Scenario: `cache-control` is copied only when the session was refreshed on this request; otherwise the per-user 404
  has no cache directive. A shared cache or the browser could reuse it after the user is added to the lane.
- Fix: always set `cache-control: private, no-store` (and `vary: cookie`) on the proxy 404.

### L4. Inline theme script vs future CSP
- Where: `apps/web/app/layout.tsx:34`.
- No injection today (constant string, whitelisted values). A strict CSP will need a nonce or a sha256 hash of
  `THEME_INIT`. Agree with the builder's log entry; add the hash when the CSP task lands.

### L5. e2e-reset silently continues without the publishable key
- Where: `apps/web/scripts/e2e-reset.mjs:12-15`; `e2e/zz-lane-shell-http.spec.ts:6` (`?? ""`).
- Scenario: if `supabase status` output changes, the spec runs with an empty apikey and fails with an unhelpful Auth
  error. Also, the full `status` stdout (local secret/service-role keys, local JWT secret) sits in memory; it is not
  printed, which is correct.
- Fix: throw in global setup when the key is not found; keep never logging `status.stdout`.

### L6. listLanes trusts `code` shape from the database
- Where: `lane-router/index.ts:136-138`.
- The table's check constraint enforces `^[A-Z]{1,8}$`, so hrefs built from it are safe. Defence in depth: filter rows
  with the same `LANE_ID` regex the router uses for input.

## Rule-by-rule
1 laneId: OK (listLanes is the cross-lane listing and is RLS-scoped; theme is a UI preference, not lane data).
2 company code: M2. 3 tables/RLS: no SQL changed. 4 connectors/tokens: no tokens logged or returned; access token only
in server-side Authorization header. 5 external writes: none. 6 content: none stored. 7-8: n/a. 9 untrusted
content: n/a. 10 synthetic only: OK. 11: n/a. 12 production: OK (local only). 13 scope: OK.

## Follow-up diff (sign-in redirects)

Scope: uncommitted changes to `apps/web/app/sign-in/actions.ts`, `apps/web/app/auth/confirm/route.ts`,
`apps/web/app/mfa/actions.ts`, new `apps/web/lib/landing.ts`, `apps/web/app/page.tsx`, `packages/ui/src/lib/nav.ts`,
e2e helpers/shell spec timeouts, `packages/eslint-plugin/src/config-files.test.js` timeout.

Result: no BLOCKER, no HIGH.

### Checks performed
- Open redirect. `safeNextPath` (`packages/core/src/auth/index.ts:261-272`) requires a leading `/`, rejects `//`,
  backslash, whitespace and C0/C1 controls, re-parses against a fixed origin, and rejects a different origin or a
  pathname that starts with `//` after dot-segment removal. Run against `//evil`, `/\evil`, `/%2F%2Fevil`, `/%2f/evil`,
  `/.//evil`, `/..//evil`, `/%2e%2e//evil`, `/a/..//evil`, `/%5Cevil`, `/%09/evil`, `/@evil`, `/;//evil`, U+3000 and
  U+2028: every result is `/` or a same-origin path that stays percent-encoded (`/%2F%2Fevil` is a path on this host;
  browsers do not decode it into `//` in a Location). `mfaPath` encodes with `encodeURIComponent`, and `/mfa` decodes
  once and runs `safeNextPath` again (`mfa/page.tsx`), so the round trip cannot introduce `//` or `&`/`#` injection.
  `landingPath` only reads `.pathname` of an already-safe value. Its output is that value unchanged or `/${laneId}`
  taken from the server list. Nothing exploitable.
- Lane leakage. `landingPath` takes the lane from `guards().listLanes()` (RLS-scoped, AAL2-gated), never from `next`
  or the URL. On any error it returns `/`, and the entry page re-checks. The lane layout and pages verify the lane
  again (lib/lane-page.ts).
- AAL bypass. `landingPath` runs only after `verifyTotp` returns `ok`. `listLanes` calls `requireSession()` without
  `allowAal1`, so an AAL1 session throws `mfa_required`, gets caught, and goes to `/`, then the proxy sends it to `/mfa`.
  The email-code and email-link flows now go straight to `/mfa`, and `/mfa` still requires a session
  (`allowAal1: true`) and redirects only AAL2. No path takes an AAL1 user to lane data. The existing e2e test "an AAL1
  session ... gets no lane data" still applies.
- Step-up. With `reauth=1` and a non-entry `next`, `landingPath` returns `next` unchanged. With `next` = `/`, the user
  goes to the first lane home (the e2e step-up spec expects this). `back()` keeps `reauth` and `next` on errors.
  Unchanged.
- Cookie on the custom confirm response. Next 16.4.2 `app-route/module.js:283-291` merges
  `requestStore.mutableCookies` (set through `next/headers` `cookies()` in `verifyEmailLink`) into whatever Response
  the handler returns, including a hand-built `NextResponse`. The e2e test "the email link signs in ... leads to the
  two-factor step" proves the cookie arrives: `/mfa` would redirect to `/sign-in` without a session.
- Caching. The confirm 303 has `cache-control: private, no-store`. Server-action redirects are POST responses
  and are not cacheable. Proxy redirects copy the refresh cache headers (as before).
- Token in the confirm URL. The relative 303 sends the browser to `/mfa`. On a redirect, Fetch keeps the original
  request's referrer, so `token_hash` is not sent onward, and the token is single-use anyway.
- Rules 1-13. No queries, tables, connectors, tokens, external writes, stored content or production actions in the
  diff. `landingPath` is the lane-selection step and gets its lane from the RLS-scoped router (rule 1 OK). No
  company-specific code (rule 2 OK). nav.ts changes text only.

### M1. New redirect behaviour has no direct tests for a non-entry `next`
- Where: `apps/web/app/sign-in/actions.ts:65` (`mfaPath(safeNextPath(pending.next))`), `apps/web/lib/landing.ts:7-15`,
  `apps/web/app/mfa/actions.ts:31,47`.
- Scenario: the e2e suite only covers `next` = `/` or `/?from=test` (both resolved to the lane home). A regression
  could pass every test: for example, `mfaPath` dropping or double-encoding `next`, or `landingPath` treating
  `/PKG/inbox` as the entry. A deep link could then lose its return path, or a step-up could go to the wrong page.
  Security risk is low because `safeNextPath` guards both ends, but the DoD requires tests for new behaviour.
- Fix: add Vitest unit tests for `landingPath` (with `guards` mocked): `/` -> `/PKG`, `/?x=1` -> `/PKG`, `/#a` -> `/PKG`,
  `/PKG/inbox?x` unchanged, listLanes throws -> `/`, empty list -> `/`. Add tests for `mfaPath` (`/` -> `/mfa`;
  `/PKG/inbox?a=1&b=2` -> `/mfa?next=%2FPKG%2Finbox%3Fa%3D1%26b%3D2`). Add one e2e test: signed out, open
  `/PKG/inbox`, sign in with the email code, then TOTP, and expect `/PKG/inbox`. Optionally add one where
  `/sign-in?next=%2F%2Fevil.example` ends at `/mfa` with no `next` and then at `/PKG`.

### L1. Entry page shows "no company access" for `step_up_required` and keeps the 200 status
- Where: `apps/web/app/page.tsx:25-29`.
- Scenario: `listLanes` does not throw `step_up_required` today, so this cannot happen now. If it did, the user would
  see a wrong "no company access" message. There is no loop and no leak. `forbidden` (outsider) is correct and covered
  by `mfa.spec.ts` "a member of another lane is refused at AAL2".
- Fix: optional. Send `step_up_required` to `/mfa?reauth=1`, or leave as is with the comment.

### L2. `/mfa` for an already-AAL2 user still does `redirect(next)` without `landingPath`
- Where: `apps/web/app/mfa/page.tsx` (`if (status.aal === "aal2" && !reauth) redirect(next)`).
- Scenario: functional only. An AAL2 user who opens `/mfa` (for example, by clicking an old email link while signed in)
  goes to `/`, which redirects while streaming. This is the "wrong URL in the address bar" problem the diff fixes
  elsewhere. Not a security issue.
- Fix: `redirect(await landingPath(next))` for consistency.

### L3. Email-link flow drops the return path
- Where: `apps/web/app/auth/confirm/route.ts:17` (always `/mfa`).
- Scenario: the link flow never carried `next` (before this diff either), so a deep link through the link flow lands
  on the lane home. Not a security issue. Do not add `next` from the confirm URL's query without `safeNextPath`.
- Fix: none required. If added later, carry it through `safeNextPath` + `encodeURIComponent` as in `mfaPath`.
