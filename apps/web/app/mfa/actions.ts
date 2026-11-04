"use server";
// Two-factor actions (T-019). Enrolment starts from a POST (never while rendering), and a wrong code during enrolment
// returns an error to the same form, so the QR code the user scanned stays valid (T-019 review M2).
import { redirect } from "next/navigation";
import { safeNextPath } from "@nichols/core/auth";
import { mfa } from "@/lib/guards";
import { landingPath } from "@/lib/landing";

export type EnrollmentState = { factorId: string; qrDataUri: string; secret: string } | { error: "unavailable" } | null;
export type VerifyState = { error: "code" | "locked" | "refused" | "unavailable" } | null;

export async function beginEnrollment(): Promise<EnrollmentState> {
  try {
    return await (await mfa()).beginTotpEnrollment();
  } catch {
    return { error: "unavailable" };
  }
}

/** Verifies the first code of a new authenticator; on success the session is AAL2 and the user continues. */
export async function verifyEnrollment(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  let result;
  try {
    result = await (await mfa()).verifyTotp(String(formData.get("factorId") ?? ""), String(formData.get("code") ?? ""), {
      enrolling: true,
    });
  } catch {
    return { error: "unavailable" };
  }
  if (result !== "ok") return { error: result === "wrong" ? "code" : result };
  redirect(await landingPath(safeNextPath(formData.get("next"))));
}

/** Verifies a code for the user's existing authenticator (every sign-in, and step-up with `reauth`). */
export async function verifyTotp(formData: FormData) {
  const next = safeNextPath(formData.get("next"));
  const reauth = formData.get("reauth") === "1";
  const back = (error: string) =>
    `/mfa?error=${error}${reauth ? "&reauth=1" : ""}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
  let result;
  try {
    result = await (await mfa()).verifyTotp(String(formData.get("factorId") ?? ""), String(formData.get("code") ?? ""));
  } catch {
    redirect(back("unavailable"));
  }
  if (result !== "ok") redirect(back(result === "wrong" ? "code" : result));
  redirect(await landingPath(next));
}
