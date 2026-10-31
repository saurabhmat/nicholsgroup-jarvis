// Request-scoped session guards (T-017) for route handlers and server actions. The session comes from the request
// cookies and is verified in @nichols/core/auth (server-only).
import { cookies } from "next/headers";
import { cookieSessionReader, createGuards, type Guards } from "@nichols/core/auth";

export async function guards(): Promise<Guards> {
  return createGuards(cookieSessionReader(await cookies()));
}
