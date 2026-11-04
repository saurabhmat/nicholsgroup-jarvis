// A signed-in AAL2 session WITHOUT a browser (T-023): signs a seeded persona in against the LOCAL Supabase Auth API
// (emailed code from Mailpit, then TOTP) and returns the session cookie header, so HTTP-level specs run on machines
// that cannot launch Chromium. Local only; uses Playwright's request client (the fetch boundary is reserved for
// packages/connectors). The local publishable key is passed in by the spec (from global setup) and is never printed.
import { request } from "@playwright/test";
import { knownAuthenticator, rememberAuthenticator } from "./helpers";
import { clearMailbox, latestSignInEmail } from "./mailpit";
import { totp } from "./totp";

const AUTH = "http://127.0.0.1:54321/auth/v1/";
const COOKIE_NAME = "sb-127-auth-token"; // @supabase/ssr: sb-<first host label>-auth-token
const CHUNK = 3180; // @supabase/ssr's cookie chunk size

type Session = { access_token: string; refresh_token: string; expires_at: number; expires_in: number; token_type: string; user: unknown };

function cookieHeader(session: Session): string {
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  if (value.length <= CHUNK) return `${COOKIE_NAME}=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * CHUNK < value.length; i++) parts.push(`${COOKIE_NAME}.${String(i)}=${value.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  return parts.join("; ");
}

/**
 * Signs `email` in to AAL2 and returns a Cookie header value. If the persona already has an authenticator (enrolled
 * by an earlier browser spec in this run) its remembered secret is used after the next 30 s window; otherwise one is
 * enrolled through the API and remembered.
 */
export async function aal2Cookie(email: string, publishableKey: string): Promise<string> {
  const api = await request.newContext({ baseURL: AUTH, extraHTTPHeaders: { apikey: publishableKey } });
  try {
    await clearMailbox();
    const sent = await api.post("otp", { data: { email, create_user: false } });
    if (!sent.ok()) throw new Error(`api-session: code request failed (${String(sent.status())})`);
    const { code } = await latestSignInEmail(email);
    const verified = await api.post("verify", { data: { type: "email", email, token: code } });
    if (!verified.ok()) throw new Error(`api-session: code refused (${String(verified.status())})`);
    let session = (await verified.json()) as Session;
    const bearer = () => ({ authorization: `Bearer ${session.access_token}` });

    const user = (await (await api.get("user", { headers: bearer() })).json()) as { factors?: { id: string; factor_type: string; status: string }[] };
    const existing = user.factors?.find((f) => f.factor_type === "totp" && f.status === "verified");
    let factorId: string;
    let secret: string | undefined;
    if (existing) {
      factorId = existing.id;
      secret = knownAuthenticator(email);
      if (!secret) throw new Error(`api-session: ${email} is enrolled outside this run; reset the database`);
      await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500)); // a used code cannot be replayed
    } else {
      const enrolled = await api.post("factors", { headers: bearer(), data: { factor_type: "totp", friendly_name: "api-e2e" } });
      const body = (await enrolled.json()) as { id: string; totp: { secret: string } };
      factorId = body.id;
      secret = body.totp.secret;
    }
    const challenge = (await (await api.post(`factors/${factorId}/challenge`, { headers: bearer(), data: {} })).json()) as { id: string };
    const done = await api.post(`factors/${factorId}/verify`, { headers: bearer(), data: { challenge_id: challenge.id, code: totp(secret) } });
    if (!done.ok()) throw new Error(`api-session: authenticator code refused (${String(done.status())})`);
    session = (await done.json()) as Session;
    rememberAuthenticator(email, secret);
    return cookieHeader(session);
  } finally {
    await api.dispose();
  }
}
