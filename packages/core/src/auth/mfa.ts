import "server-only";
// TOTP multi-factor authentication (T-019, D-6): every user enrols an authenticator app once and enters its code after
// the email code; sessions without it stay at AAL1 and get no data (route guards and RLS require AAL2).
// Auth calls only (`auth.mfa.*`); no data queries. Secrets and QR codes are returned to the page once and never logged.
import { z } from "zod";
import type { Aal, CookieStore } from "./index";
import { authClient } from "./client";

export type MfaStatus = { aal: Aal | null; verifiedFactorId: string | null };
/** `locked`: too many wrong codes (15 minutes); `refused`: a new authenticator needs an admin reset (T-020). */
export type TotpResult = "ok" | "wrong" | "locked" | "refused";
/** `qrDataUri` is always a `data:image/svg+xml` URI, ready for an <img src>. */
export type TotpEnrollment = { factorId: string; qrDataUri: string; secret: string };

export type MfaActions = {
  /** The session's current AAL and the user's verified TOTP factor, if any. */
  status(): Promise<MfaStatus>;
  /**
   * Starts a new TOTP enrolment for a user without a verified factor. Unfinished enrolments older than 10 minutes are
   * removed; recent ones are kept (a second tab or a retry does not invalidate a QR code being scanned). Call it from a
   * POST (server action), never while rendering a page.
   */
  beginTotpEnrollment(): Promise<TotpEnrollment>;
  /**
   * Verifies a code for one of THIS user's TOTP factors; on "ok" the session becomes AAL2 (cookie updated).
   * `enrolling`: the factor must be the user's unverified new one; otherwise it must be a verified one, so a code for
   * a half-added authenticator never counts as signing in or step-up (the database hook enforces the rest).
   */
  verifyTotp(factorId: string, code: string, opts?: { enrolling?: boolean }): Promise<TotpResult>;
};

const factorIdSchema = z.uuid();
const STALE_ENROLLMENT_MS = 10 * 60 * 1000;
/** Unfinished enrolments kept (newest first) so a second tab still works, without filling the factor limit. */
const KEEP_RECENT_UNVERIFIED = 2;

/** Our database hook's reject messages (core.mfa_verification_attempt) mapped to results. */
function hookResult(message: string | undefined): TotpResult {
  if (message?.includes("Too many attempts")) return "locked";
  if (message?.includes("administrator resets")) return "refused";
  return "wrong";
}
const codeSchema = z.string().regex(/^\d{6}$/);

/**
 * Supabase returns the QR code either as raw SVG (as documented) or, in current versions, as a complete SVG data URI.
 * Normalises both to a data URI and refuses anything else.
 */
export function qrDataUri(qr: string): string {
  const svgUri = "data:image/svg+xml;utf-8,";
  if (qr.startsWith(svgUri)) return qr;
  if (qr.trimStart().startsWith("<svg")) return `${svgUri}${encodeURIComponent(qr)}`;
  throw new Error("unexpected QR code format");
}

const unavailable = (error: { name?: string } | null) => {
  if (error?.name === "AuthRetryableFetchError") throw new Error("auth service unavailable");
};

export function mfaActions(cookies: CookieStore): MfaActions {
  const supabase = () => authClient(cookies);
  return {
    async status() {
      const client = supabase();
      const [{ data: aalData, error: aalError }, { data: factors, error: factorError }] = await Promise.all([
        client.auth.mfa.getAuthenticatorAssuranceLevel(),
        client.auth.mfa.listFactors(),
      ]);
      unavailable(aalError);
      unavailable(factorError);
      const level = aalData?.currentLevel;
      return {
        aal: level === "aal2" ? "aal2" : level === "aal1" ? "aal1" : null,
        verifiedFactorId: factors?.totp[0]?.id ?? null,
      };
    },

    async beginTotpEnrollment() {
      const client = supabase();
      const { data: factors, error: listError } = await client.auth.mfa.listFactors();
      unavailable(listError);
      if (listError || !factors) throw new Error("mfa unavailable");
      if (factors.totp.length > 0) throw new Error("already enrolled"); // a verified factor exists: challenge instead
      const staleBefore = Date.now() - STALE_ENROLLMENT_MS;
      const unverified = factors.all
        .filter((f) => f.factor_type === "totp" && f.status === "unverified")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      for (const [i, f] of unverified.entries()) {
        if (Date.parse(f.created_at) < staleBefore || i >= KEEP_RECENT_UNVERIFIED) {
          await client.auth.mfa.unenroll({ factorId: f.id });
        }
      }
      const { data, error } = await client.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${new Date().toISOString()}`, // unique per user, as Supabase requires
      });
      unavailable(error);
      if (error || !data) throw new Error("mfa unavailable");
      return { factorId: data.id, qrDataUri: qrDataUri(data.totp.qr_code), secret: data.totp.secret };
    },

    async verifyTotp(factorId, code, opts) {
      const f = factorIdSchema.safeParse(factorId);
      const c = codeSchema.safeParse(code.trim());
      if (!f.success || !c.success) return "wrong";
      const client = supabase();
      // Only this user's own factors, in the expected state (Supabase checks ownership too).
      const { data: factors, error: listError } = await client.auth.mfa.listFactors();
      unavailable(listError);
      const wanted = opts?.enrolling ? "unverified" : "verified";
      if (!factors?.all.some((x) => x.id === f.data && x.factor_type === "totp" && x.status === wanted)) return "wrong";
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: f.data, code: c.data });
      unavailable(error);
      return error ? hookResult(error.message) : "ok";
    },
  };
}
