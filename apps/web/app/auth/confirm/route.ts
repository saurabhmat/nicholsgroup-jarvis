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
  const url = request.nextUrl.clone();
  url.search = "";
  url.pathname = ok ? "/" : "/sign-in";
  if (!ok) url.searchParams.set("error", "link");
  return NextResponse.redirect(url);
}
