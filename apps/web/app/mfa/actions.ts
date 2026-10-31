"use server";
// Two-factor verification (T-019): checks a TOTP code for the user's own factor; on success the session is AAL2.
import { redirect } from "next/navigation";
import { safeNextPath } from "@nichols/core/auth";
import { mfa } from "@/lib/guards";

export async function verifyTotp(formData: FormData) {
  const next = safeNextPath(formData.get("next"));
  const back = (error: string) => `/mfa?error=${error}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
  let ok = false;
  try {
    ok = await (await mfa()).verifyTotp(String(formData.get("factorId") ?? ""), String(formData.get("code") ?? ""));
  } catch {
    redirect(back("unavailable"));
  }
  if (!ok) redirect(back("code"));
  redirect(next);
}
