// Request-scoped session guards and sign-in actions (T-017, T-018) for route handlers, server actions and server
// components. The session comes from the request cookies and is verified in @nichols/core/auth (server-only).
import { cookies } from "next/headers";
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

export async function guards(): Promise<Guards> {
  const read = cookieSessionReader(await cookieStore());
  const g = createGuards(() => timed("guards.session", read), {
    getLaneClient: (laneId, session) => timed("guards.lane", () => getLaneClient(laneId, session)),
    listLanes: (session) => timed("guards.lanes", () => listLanes(session)),
  });
  return { ...g, requireRole: (laneId, roles) => timed("guards.role", () => g.requireRole(laneId, roles)) };
}

export async function auth(): Promise<AuthActions> {
  return authActions(await cookieStore());
}

export async function mfa(): Promise<MfaActions> {
  return mfaActions(await cookieStore());
}
