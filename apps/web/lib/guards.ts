// Request-scoped session guards and sign-in actions (T-017, T-018) for route handlers, server actions and server
// components. The session comes from the request cookies and is verified in @nichols/core/auth (server-only).
import { cookies } from "next/headers";
import { authActions, cookieSessionReader, createGuards, type AuthActions, type CookieStore, type Guards } from "@nichols/core/auth";

async function cookieStore(): Promise<CookieStore> {
  const store = await cookies();
  return {
    getAll: () => store.getAll(),
    // Throws in server components (read-only); the auth module ignores that, and proxy.ts refreshes instead.
    setAll: (list) => {
      for (const c of list) store.set(c.name, c.value, c.options);
    },
  };
}

export async function guards(): Promise<Guards> {
  return createGuards(cookieSessionReader(await cookieStore()));
}

export async function auth(): Promise<AuthActions> {
  return authActions(await cookieStore());
}
