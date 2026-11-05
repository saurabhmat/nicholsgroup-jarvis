// Reads sign-in codes from the local Mailpit (Supabase local SMTP, port 54324). Local only. Uses Playwright's request
// client (test tooling), not fetch, which the boundary rules reserve for packages/connectors.
import { request } from "@playwright/test";

const MAILPIT = "http://127.0.0.1:54324/api/v1/";

type Summary = { ID: string };

async function mailpit() {
  return request.newContext({ baseURL: MAILPIT });
}

export async function clearMailbox(): Promise<void> {
  const ctx = await mailpit();
  await ctx.delete("messages");
  await ctx.dispose();
}

async function messagesTo(email: string): Promise<Summary[]> {
  const ctx = await mailpit();
  const res = await ctx.get("search", { params: { query: `to:${email}` } });
  const { messages } = (await res.json()) as { messages: Summary[] };
  await ctx.dispose();
  return messages;
}

export async function countMessagesTo(email: string): Promise<number> {
  return (await messagesTo(email)).length;
}

/** The newest sign-in email to `email`: its 6-digit code and the sign-in link. Polls for up to 10 s. */
export async function latestSignInEmail(email: string): Promise<{ code: string; link: string }> {
  for (let i = 0; i < 40; i++) {
    const newest = (await messagesTo(email))[0];
    if (newest) {
      const ctx = await mailpit();
      const msg = (await (await ctx.get(`message/${newest.ID}`)).json()) as { HTML: string };
      await ctx.dispose();
      const code = /(\d{6})/.exec(msg.HTML.replace(/<[^>]+>/g, " "))?.[1];
      const link = /href="([^"]*\/auth\/confirm[^"]*)"/.exec(msg.HTML)?.[1]?.replaceAll("&amp;", "&");
      if (code && link) return { code, link };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in email for ${email}`);
}
