// Request-scoped session guards and sign-in actions (T-017, T-018) for route handlers, server actions and server
// components. The session comes from the request cookies and is verified in @nichols/core/auth (server-only).
import { cache } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import {
  authActions,
  cookieSessionReader,
  createGuards,
  mfaActions,
  type AuthActions,
  type CookieStore,
  type Guards,
  type MfaActions,
} from "@nichols/core/auth";
import { getLaneClient, listLanes } from "@nichols/core/lane-router";
import { timed } from "./timed";

async function cookieStore(): Promise<CookieStore> {
  // T-243 review: auth() and mfa() build a Supabase auth client from this store; wait for the request first, as guards() does, so no
  // server component can make supabase-js read the session inside a prerender. Resolves at once in actions and route handlers.
  await connection();
  const store = await cookies();
  return {
    getAll: () => store.getAll(),
    // Throws in server components (read-only); the auth module ignores that, and proxy.ts refreshes instead.
    // Cache headers (second argument) cannot be set from here; proxy.ts applies them on every request.
    setAll: (list) => {
      for (const c of list) store.set(c.name, c.value, c.options);
    },
  };
}

// T-230 A: one set of guards per request AND per session. React cache() is scoped to one server render, so nothing is shared
// between requests or users; the key is the auth cookie content itself, so a request whose cookies change (a server action
// that signs in or refreshes the session, then renders the redirect target) builds fresh guards instead of reusing a stale
// read. Inside, the session is read and verified once, and the lane, lane list and role answers are memoised per argument:
// the layout, the page and its loaders all ask the same questions. Every check still runs (once); a rejection is memoised
// too, so an AuthError or an outage gives the same answer to every caller in the render. Outside a render (route handlers,
// server actions) cache() does not memoise and each call builds its own guards, as before.
// Verified (T-230 A review, `next dev` with SERVER_TIMING=1): the route handlers GET /api/lanes/PKG and POST
// /api/lanes/PKG/brain/interview answer 200 with timing on (so `connection()` in timed() does not throw there), and their
// spans carry a different request id each, i.e. React cache() did not memoise anything outside a render. Server actions do call
// guards() (briefing-actions, news-actions): cache() does not memoise there and connection() resolves at once. Sign-in and MFA
// actions use auth()/mfa(), which are not cached.
const guardsFor = cache(async (authCookies: string): Promise<Guards> => {
  void authCookies; // only the cache key: see above
  const read = cookieSessionReader(await cookieStore());
  let session: ReturnType<typeof read> | undefined;
  const readOnce = () => (session ??= timed("guards.session", read));
  const clients = new Map<string, ReturnType<typeof getLaneClient>>();
  let lanes: ReturnType<typeof listLanes> | undefined;
  const g = createGuards(readOnce, {
    getLaneClient: (laneId, s) => {
      let c = clients.get(laneId);
      if (c === undefined) {
        c = timed("guards.lane", () => getLaneClient(laneId, s));
        clients.set(laneId, c);
      }
      return c;
    },
    listLanes: (s) => (lanes ??= timed("guards.lanes", () => listLanes(s))),
  });
  const roles = new Map<string, ReturnType<Guards["requireRole"]>>();
  return {
    ...g,
    requireRole: (laneId, wanted) => {
      const key = JSON.stringify([laneId, [...wanted].sort()]);
      let r = roles.get(key);
      if (r === undefined) {
        r = timed("guards.role", () => g.requireRole(laneId, wanted));
        roles.set(key, r);
      }
      return r;
    },
  };
});

export async function guards(): Promise<Guards> {
  // T-243 (production: "Next.js encountered the unstable value `Date.now()` while prerendering" at GoTrueClient.__loadSession, on
  // /[laneId] and /[laneId]/settings). With runtime prefetching, Next prerenders with the request's cookies, so cookies() resolves while
  // connection() does not. The layout called guards() for the first name alongside loadLane (which awaits connection()), so the
  // Supabase auth client read its session (Date.now) inside that prerender. Waiting for the request here first makes every caller safe:
  // nothing under guards() (session read, clients, clocks) is part of a prerender. A no-op in route handlers and server actions.
  await connection();
  const store = await cookies();
  const authCookies = store
    .getAll()
    .filter((c) => c.name.startsWith("sb-"))
    .map((c) => `${c.name}=${c.value}`)
    .join(";");
  return guardsFor(authCookies);
}

export async function auth(): Promise<AuthActions> {
  return authActions(await cookieStore());
}

export async function mfa(): Promise<MfaActions> {
  return mfaActions(await cookieStore());
}
