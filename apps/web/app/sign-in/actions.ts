"use server";
// Sign-in server actions (T-018). The address being signed in is kept in a short-lived httpOnly cookie between the
// two steps, so it never appears in a URL or the browser history.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeNextPath } from "@nichols/core/auth";
import { getServerEnv } from "@nichols/core/env/server";
import { auth } from "@/lib/guards";
import { mfaPath } from "@/lib/mfa-path";

const PENDING = "signin_pending";
/** Wrong codes allowed per emailed code before a new one is required (T-018 review M2). */
const MAX_ATTEMPTS = 5;

async function setPending(value: { email: string; next: string; attempts: number }) {
  (await cookies()).set(PENDING, JSON.stringify(value), {
    httpOnly: true,
    secure: getServerEnv().APP_ENV !== "local",
    sameSite: "lax",
    path: "/sign-in",
    maxAge: 10 * 60, // the code's lifetime (otp_expiry)
  });
}

export async function sendCode(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const next = safeNextPath(formData.get("next"));
  try {
    await (await auth()).sendSignInCode(email);
  } catch (e) {
    redirect(`/sign-in?error=${e instanceof Error && e.name === "AuthError" ? "email" : "unavailable"}`);
  }
  await setPending({ email: email.trim().toLowerCase(), next, attempts: 0 });
  redirect("/sign-in/verify");
}

export async function verifyCode(formData: FormData) {
  const store = await cookies();
  let pending: { email?: unknown; next?: unknown; attempts?: unknown } = {};
  try {
    pending = JSON.parse(store.get(PENDING)?.value ?? "{}") as typeof pending;
  } catch {
    /* treated as missing */
  }
  if (typeof pending.email !== "string") redirect("/sign-in");
  let ok = false;
  try {
    ok = await (await auth()).verifySignInCode(pending.email, String(formData.get("code") ?? ""));
  } catch {
    redirect("/sign-in/verify?error=unavailable");
  }
  if (!ok) {
    const attempts = (typeof pending.attempts === "number" ? pending.attempts : 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      store.delete({ name: PENDING, path: "/sign-in" });
      redirect("/sign-in?error=attempts");
    }
    await setPending({ email: pending.email, next: safeNextPath(pending.next), attempts });
    redirect("/sign-in/verify?error=code");
  }
  store.delete({ name: PENDING, path: "/sign-in" });
  // Every user has MFA (D-6), so the email code always ends at AAL1: go straight to the two-factor step. Redirecting to
  // the next page and letting the proxy bounce it to /mfa renders /mfa under the old URL (client navigation after a
  // server-action redirect does not follow the proxy's redirect in the address bar).
  redirect(mfaPath(safeNextPath(pending.next)));
}

export async function signOut() {
  await (await auth()).signOut();
  redirect("/sign-in");
}
