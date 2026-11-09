// Next 16 proxy (T-018, T-019): refreshes the Supabase session cookie on every matched request; signed-out page
// requests go to /sign-in and AAL1 (email code only) page requests go to /mfa. API routes are not redirected: their
// guards answer 401/403 (T-017), and RLS refuses AAL1 anyway.
import { NextResponse, type NextRequest } from "next/server";
import { cookieSessionReader, createGuards, laneSegment, laneVerdict, refreshSession, safeNextPath, type CookieStore } from "@nichols/core/auth";
import { isOnboardingPath, onboardingVerdict } from "@/lib/onboarding-gate";
import { createTimings, timingEnabled } from "@/lib/server-timing";

const PUBLIC_PATHS = ["/sign-in", "/auth/confirm"];
const MFA_PATH = "/mfa";

const under = (pathname: string, p: string) => pathname === p || pathname.startsWith(`${p}/`);

// Same body for every refused lane (unknown, disabled, not yours), so nothing reveals which lanes exist. Plain on
// purpose: the proxy cannot render the app's styled not-found page (a rewrite is proxied by origin and fails when the
// dev server listens on 127.0.0.1 only), and the styled page is what the layout and pages show on their own check.
const NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Page not found</title></head><body><h1>Page not found</h1><p>This page does not exist, or you do not have access to it.</p><p><a href="/">Go to your home page</a></p></body></html>';

export async function proxy(request: NextRequest) {
  // T-230 A: names and durations only, on the response, and only in dev or with SERVER_TIMING=1 on the server.
  const timings = createTimings(null);
  const stamp = <R extends NextResponse>(r: R): R => {
    if (timingEnabled()) r.headers.set("server-timing", timings.header());
    return r;
  };
  let response = NextResponse.next({ request });
  const cookieStore: CookieStore = {
    getAll: () => request.cookies.getAll(),
    setAll: (list, headers) => {
      for (const c of list) request.cookies.set(c.name, c.value);
      response = NextResponse.next({ request });
      for (const c of list) response.cookies.set(c.name, c.value, c.options);
      for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
    },
  };
  const { signedIn, aal } = await timings.time("proxy.auth", () => refreshSession(cookieStore));

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/") || PUBLIC_PATHS.some((p) => under(pathname, p))) return stamp(response);

  const target = !signedIn ? "/sign-in" : aal !== "aal2" && !under(pathname, MFA_PATH) ? MFA_PATH : null;
  if (!target) {
    // Lane in the URL (T-023): answer a lane the user cannot open with a real 404 status before streaming starts. This
    // is only about the status code: the layout and every page verify the lane again (lib/lane-page.ts), and anything
    // other than a definite refusal (outage, expired session) is passed through to them.
    const segment = laneSegment(pathname);
    const guards = segment && signedIn ? createGuards(cookieSessionReader(cookieStore)) : null;
    // H-042: the onboarding page is only for an owner with the brain view. Its own notFound() runs inside a Suspense
    // boundary after the shell has streamed (status 200), so the status is decided here, before streaming. Its check
    // (requireRole) includes the lane check, so onboarding paths skip the separate lane verdict (one set of round trips).
    const denied =
      guards !== null &&
      segment !== null &&
      (await timings.time("proxy.lane", () => (isOnboardingPath(pathname) ? onboardingVerdict(guards, segment) : laneVerdict(guards, segment)))) === "denied";
    if (denied) {
      const hidden = new NextResponse(NOT_FOUND_HTML, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      for (const c of response.cookies.getAll()) hidden.cookies.set(c);
      // Per user and never stored, whether or not the session was refreshed on this request.
      hidden.headers.set("cache-control", "private, no-store");
      hidden.headers.set("vary", "cookie");
      return stamp(hidden);
    }
    return stamp(response);
  }
  const url = request.nextUrl.clone();
  url.pathname = target;
  url.search = "";
  const next = safeNextPath(`${pathname}${search}`);
  if (next !== "/" && !under(pathname, MFA_PATH)) url.searchParams.set("next", next);
  const redirect = NextResponse.redirect(url);
  for (const c of response.cookies.getAll()) redirect.cookies.set(c);
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl) redirect.headers.set("cache-control", cacheControl);
  return stamp(redirect);
}

export const config = {
  // Everything except static assets and images and provider webhooks. The proxy is not the auth gate: every page and
  // route calls the guards (T-017) itself; the proxy only refreshes cookies and redirects. Webhooks (T-036) carry no
  // session: the provider's signature is their credential, and the proxy must not read cookies or call Supabase for them.
  matcher: ["/((?!_next/static/|_next/image$|api/webhooks/|favicon\\.ico$|[^?]*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
