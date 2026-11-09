// The origin notice for the page being rendered (T-226): the request's host against NEXT_PUBLIC_APP_URL.
import { headers } from "next/headers";
import { getServerEnv } from "@nichols/core/env/server";
import { originNotice, type OriginNotice } from "./origin-notice";

export async function currentOriginNotice(): Promise<OriginNotice | null> {
  try {
    const h = await headers();
    return originNotice(h.get("x-forwarded-host") ?? h.get("host"), getServerEnv().NEXT_PUBLIC_APP_URL);
  } catch {
    return null; // no notice rather than a broken Settings page
  }
}
