// Next 16 proxy (T-018, T-019): refreshes the Supabase session cookie on every matched request; signed-out page
// requests go to /sign-in and AAL1 (email code only) page requests go to /mfa. API routes are not redirected: their
// guards answer 401/403 (T-017), and RLS refuses AAL1 anyway.
import { NextResponse, type NextRequest } from "next/server";
import { refreshSession, safeNextPath } from "@nichols/core/auth";

const PUBLIC_PATHS = ["/sign-in", "/auth/confirm"];
const MFA_PATH = "/mfa";

const under = (pathname: string, p: string) => pathname === p || pathname.startsWith(`${p}/`);

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { signedIn, aal } = await refreshSession({
    getAll: () => request.cookies.getAll(),
    setAll: (list, headers) => {
      for (const c of list) request.cookies.set(c.name, c.value);
      response = NextResponse.next({ request });
      for (const c of list) response.cookies.set(c.name, c.value, c.options);
      for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
    },
  });

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/") || PUBLIC_PATHS.some((p) => under(pathname, p))) return response;

  const target = !signedIn ? "/sign-in" : aal !== "aal2" && !under(pathname, MFA_PATH) ? MFA_PATH : null;
  if (!target) return response;
  const url = request.nextUrl.clone();
  url.pathname = target;
  url.search = "";
  const next = safeNextPath(`${pathname}${search}`);
  if (next !== "/" && !under(pathname, MFA_PATH)) url.searchParams.set("next", next);
  const redirect = NextResponse.redirect(url);
  for (const c of response.cookies.getAll()) redirect.cookies.set(c);
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl) redirect.headers.set("cache-control", cacheControl);
  return redirect;
}

export const config = {
  // Everything except static assets and images. The proxy is not the auth gate: every page and route calls the
  // guards (T-017) itself; the proxy only refreshes cookies and redirects.
  matcher: ["/((?!_next/static/|_next/image$|favicon\\.ico$|[^?]*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
