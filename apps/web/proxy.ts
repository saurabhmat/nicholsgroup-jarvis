// Next 16 proxy (T-018): refreshes the Supabase session cookie on every matched request and sends signed-out page
// requests to /sign-in. API routes are not redirected: their guards answer 401/403 (T-017).
import { NextResponse, type NextRequest } from "next/server";
import { refreshSession, safeNextPath } from "@nichols/core/auth";

const PUBLIC_PATHS = ["/sign-in", "/auth/confirm"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { signedIn } = await refreshSession({
    getAll: () => request.cookies.getAll(),
    setAll: (list) => {
      for (const c of list) request.cookies.set(c.name, c.value);
      response = NextResponse.next({ request });
      for (const c of list) response.cookies.set(c.name, c.value, c.options);
    },
  });

  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!signedIn && !isPublic && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    const next = safeNextPath(`${pathname}${search}`);
    if (next !== "/") url.searchParams.set("next", next);
    const redirect = NextResponse.redirect(url);
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  return response;
}

export const config = {
  // Everything except static assets and images.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
