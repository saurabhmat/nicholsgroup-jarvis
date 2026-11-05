// Email link sign-in (T-018, secondary flow): the link in the sign-in email lands here with a token hash.
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/guards";

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash") ?? "";
  let ok = false;
  try {
    ok = await (await auth()).verifyEmailLink(tokenHash);
  } catch {
    ok = false;
  }
  // A relative Location keeps the browser on the host it signed in on. request.nextUrl can name a different host than
  // the browser used (next dev reports localhost for 127.0.0.1), and the session cookie would not follow. Every user
  // has MFA (D-6), so a valid link ends at AAL1 and goes straight to the two-factor step.
  return new NextResponse(null, {
    status: 303,
    headers: { location: ok ? "/mfa" : "/sign-in?error=link", "cache-control": "private, no-store" },
  });
}
