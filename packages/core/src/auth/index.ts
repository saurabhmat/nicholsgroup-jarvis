import "server-only";
// Session → lane guards for route handlers and server actions (T-017). Import path: @nichols/core/auth
//
// - cookieSessionReader(cookies): reads the Supabase session from the request cookies (@supabase/ssr) and VERIFIES
//   the access token (`auth.getClaims`), so the user id and AAL come from a checked JWT, not from cookie contents.
// - requireSession(): a verified session at AAL2 (every user has TOTP, D-6/T-019); { allowAal1: true } only for the
//   sign-in and MFA pages.
// - requireLane(laneId): the session plus the lane client from the lane router (membership, enabled lane, AAL2).
// - requireRole(laneId, roles): requireLane plus core.has_lane_role() for actions a view does not imply.
// - authActions(cookies): sign-in by 6-digit email code (primary, D-6) or email link; sign-out (T-018).
// - refreshSession(cookies): for proxy.ts; refreshes the session cookie and reports whether it is signed in.
// Failures throw AuthError (401 without a valid session, 403 otherwise); authErrorResponse() turns one into a Response.
// An auth outage or a configuration error is NOT reported as "no session": it propagates (the route answers 503).
import { z } from "zod";
import { getServerEnv } from "../env/server";
import type { LaneId } from "../lanes/index";
import { authClient } from "./client";
import { getLaneClient, LaneAccessError, type LaneClient, type LaneRouter, type LaneSession } from "../lane-router/index";

export type Aal = "aal1" | "aal2";
export type VerifiedSession = LaneSession & { aal: Aal };
export type SessionReader = () => Promise<VerifiedSession | null>;
export type Role = "owner" | "finance_operator" | "viewer" | "admin_technical";

/**
 * Request cookies, and (where the framework allows writing) a way to set the refreshed session cookies.
 * apps/web adapts Next's `cookies()` store and the proxy's request/response to this shape.
 */
export type CookieStore = {
  getAll(): { name: string; value: string }[];
  setAll?(
    cookies: { name: string; value: string; options?: Record<string, unknown> }[],
    headers?: Record<string, string>,
  ): void;
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
    const supabase = authClient(cookies);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return null;
    // Verify THIS token and take identity and AAL from its verified claims only, never from the cookie's user object.
    const { data, error } = await supabase.auth.getClaims(token);
    if (error?.name === "AuthRetryableFetchError") throw new Error("auth service unavailable");
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
    // The reader returns null for a missing or invalid session; anything it throws is an outage or misconfiguration.
    const session = await readSession();
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

// ---------------------------------------------------------------- sign-in and sign-out (T-018)

const emailSchema = z.email().max(254);
const codeSchema = z.string().regex(/^\d{6}$/);
const tokenHashSchema = z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+$/);

export type AuthActions = {
  /**
   * Emails a 6-digit code (and a link) to an EXISTING user; never creates users (invite-only). Resolves the same way
   * whether or not the address belongs to a user, so the form cannot be used to discover accounts. Throws
   * AuthError("forbidden") only for a malformed address.
   */
  sendSignInCode(email: string): Promise<void>;
  /** Verifies the 6-digit code; on success the session cookie is set. False for a wrong or expired code. */
  verifySignInCode(email: string, code: string): Promise<boolean>;
  /** Verifies an email link's token hash (secondary flow; opens in the browser). */
  verifyEmailLink(tokenHash: string): Promise<boolean>;
  /** Ends this device's session (other devices keep theirs). */
  signOut(): Promise<void>;
};

export function authActions(cookies: CookieStore): AuthActions {
  return {
    async sendSignInCode(email) {
      const parsed = emailSchema.safeParse(email.trim().toLowerCase());
      if (!parsed.success) throw new AuthError("forbidden");
      const appUrl = getServerEnv().NEXT_PUBLIC_APP_URL;
      const { error } = await authClient(cookies).auth.signInWithOtp({
        email: parsed.data,
        options: { shouldCreateUser: false, emailRedirectTo: `${appUrl}/auth/confirm` },
      });
      // Unknown address and rate limits look like success; an outage is an error (the page shows "try again").
      if (error?.name === "AuthRetryableFetchError") throw new Error("auth service unavailable");
    },
    async verifySignInCode(email, code) {
      const e = emailSchema.safeParse(email.trim().toLowerCase());
      const c = codeSchema.safeParse(code.trim());
      if (!e.success || !c.success) return false;
      const { data, error } = await authClient(cookies).auth.verifyOtp({ email: e.data, token: c.data, type: "email" });
      if (error?.name === "AuthRetryableFetchError") throw new Error("auth service unavailable");
      return !error && !!data.session;
    },
    async verifyEmailLink(tokenHash) {
      const t = tokenHashSchema.safeParse(tokenHash);
      if (!t.success) return false;
      const { data, error } = await authClient(cookies).auth.verifyOtp({ token_hash: t.data, type: "email" });
      if (error?.name === "AuthRetryableFetchError") throw new Error("auth service unavailable");
      return !error && !!data.session;
    },
    async signOut() {
      await authClient(cookies).auth.signOut({ scope: "local" });
    },
  };
}

/**
 * For proxy.ts: refreshes the session cookie when needed (writes go through cookies.setAll) and reports whether
 * the request carries a valid session and at which AAL. Never throws for a missing or invalid session.
 */
export async function refreshSession(cookies: CookieStore): Promise<{ signedIn: boolean; aal: Aal | null }> {
  const { data, error } = await authClient(cookies).auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== "string" || claims.sub === "") return { signedIn: false, aal: null };
  return { signedIn: true, aal: claims.aal === "aal2" ? "aal2" : "aal1" };
}

/**
 * A safe post-sign-in destination: a same-origin path only, returned in normalised form (dot segments resolved), so
 * nothing downstream can turn it into `//host` (T-018 review L1). "/" for anything else, including schemes, `//host`,
 * backslashes, whitespace and control characters.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || next.length > 512 || !next.startsWith("/") || next.startsWith("//")) return "/";
  if (/[\\\s\u0000-\u001f\u007f-\u009f]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, "http://next.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "http://next.invalid" || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export { mfaActions, type MfaActions, type MfaStatus, type TotpEnrollment } from "./mfa";

/** A JSON error Response for an AuthError (no detail beyond the reason); null for any other error. */
export function authErrorResponse(e: unknown): Response | null {
  if (!(e instanceof AuthError)) return null;
  return Response.json({ error: e.reason }, { status: e.status, headers: { "cache-control": "no-store" } });
}
