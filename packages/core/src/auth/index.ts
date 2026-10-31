import "server-only";
// Session → lane guards for route handlers and server actions (T-017). Import path: @nichols/core/auth
//
// - cookieSessionReader(cookies): reads the Supabase session from the request cookies (@supabase/ssr) and VERIFIES
//   the access token (`auth.getClaims`), so the user id and AAL come from a checked JWT, not from cookie contents.
// - requireSession(): a verified session at AAL2 (every user has TOTP, D-6/T-019); { allowAal1: true } only for the
//   sign-in and MFA pages.
// - requireLane(laneId): the session plus the lane client from the lane router (membership, enabled lane, AAL2).
// - requireRole(laneId, roles): requireLane plus core.has_lane_role() for actions a view does not imply.
// Failures throw AuthError (401 without a session, 403 otherwise); authErrorResponse() turns one into a Response.
import { createServerClient } from "@supabase/ssr";
import type { Database } from "../db/index";
import { getServerEnv, requireSupabasePublicEnv } from "../env/server";
import type { LaneId } from "../lanes/index";
import { getLaneClient, LaneAccessError, type LaneClient, type LaneRouter, type LaneSession } from "../lane-router/index";

export type Aal = "aal1" | "aal2";
export type VerifiedSession = LaneSession & { aal: Aal };
export type SessionReader = () => Promise<VerifiedSession | null>;
export type Role = "owner" | "finance_operator" | "viewer" | "admin_technical";

/** The parts of Next's cookie store the reader uses (`await cookies()` in a route handler or server action). */
export type CookieStore = {
  getAll(): { name: string; value: string }[];
  set?(name: string, value: string, options?: Record<string, unknown>): void;
};

export class AuthError extends Error {
  readonly status: 401 | 403;
  readonly reason: "no_session" | "mfa_required" | "forbidden";
  constructor(reason: AuthError["reason"]) {
    super({ no_session: "Sign in required.", mfa_required: "Two-factor verification required.", forbidden: "Not allowed." }[reason]);
    this.name = "AuthError";
    this.reason = reason;
    this.status = reason === "no_session" ? 401 : 403;
  }
}

export function cookieSessionReader(cookies: CookieStore): SessionReader {
  return async () => {
    const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = requireSupabasePublicEnv(getServerEnv());
    const supabase = createServerClient<Database>(url, key, {
      cookies: {
        getAll: () => cookies.getAll(),
        setAll: (list) => {
          // Refreshed tokens are written back where Next allows it (route handlers, server actions); in a server
          // component setting cookies throws, and proxy.ts (T-018) refreshes the session instead.
          try {
            for (const c of list) cookies.set?.(c.name, c.value, c.options);
          } catch {
            /* read-only cookie store */
          }
        },
      },
    });
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return null;
    const { data, error } = await supabase.auth.getClaims(token);
    const claims = data?.claims;
    if (error || !claims || typeof claims.sub !== "string" || claims.sub === "") return null;
    return { userId: claims.sub, accessToken: token, aal: claims.aal === "aal2" ? "aal2" : "aal1" };
  };
}

export type Guards = {
  requireSession(opts?: { allowAal1?: boolean }): Promise<VerifiedSession>;
  requireLane(laneId: LaneId): Promise<{ session: VerifiedSession; laneId: LaneId; client: LaneClient }>;
  requireRole(laneId: LaneId, roles: readonly Role[]): Promise<{ session: VerifiedSession; laneId: LaneId; client: LaneClient }>;
};

export function createGuards(
  readSession: SessionReader,
  router: Pick<LaneRouter, "getLaneClient"> = { getLaneClient },
): Guards {
  const requireSession: Guards["requireSession"] = async (opts) => {
    let session: VerifiedSession | null;
    try {
      session = await readSession();
    } catch {
      session = null; // an unreadable or unverifiable session is no session
    }
    if (!session) throw new AuthError("no_session");
    if (session.aal !== "aal2" && !opts?.allowAal1) throw new AuthError("mfa_required");
    return session;
  };

  const requireLane: Guards["requireLane"] = async (laneId) => {
    const session = await requireSession();
    try {
      const client = await router.getLaneClient(laneId, session);
      return { session, laneId, client };
    } catch (e) {
      if (e instanceof LaneAccessError) throw new AuthError("forbidden");
      throw e;
    }
  };

  const requireRole: Guards["requireRole"] = async (laneId, roles) => {
    const ctx = await requireLane(laneId);
    if (roles.length === 0) throw new AuthError("forbidden");
    const { data, error } = await ctx.client
      .schema("core")
      .rpc("has_lane_role", { p_uid: ctx.session.userId, p_lane: laneId, p_roles: [...roles] });
    if (error || data !== true) throw new AuthError("forbidden");
    return ctx;
  };

  return { requireSession, requireLane, requireRole };
}

/** A JSON error Response for an AuthError (no detail beyond the reason); null for any other error. */
export function authErrorResponse(e: unknown): Response | null {
  if (!(e instanceof AuthError)) return null;
  return Response.json({ error: e.reason }, { status: e.status, headers: { "cache-control": "no-store" } });
}
