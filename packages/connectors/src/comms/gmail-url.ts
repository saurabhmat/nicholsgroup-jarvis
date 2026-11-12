// The Gmail link for a thread of a connected mailbox (T-234 part 2). Gmail's `/mail/u/<n>/` takes an account INDEX, not an
// address: the old `/mail/u/<address>/#all/<id>` link was not honoured and landed on the wrong Google page. `authuser`
// accepts the address. The thread id must be Gmail's own (lower-case hex, up to 32 characters; sync-written, but still
// untrusted); anything else gives no link. The mailbox must look like one address (no spaces, controls, `#`, `?`, `/`).
const GMAIL_THREAD_ID = /^[0-9a-f]{8,32}$/;
const MAILBOX = /^[^\s@#?/\\<>"'\u0000-\u001f\u007f]{1,64}@[A-Za-z0-9.-]{1,255}$/;

export const isGmailThreadId = (v: unknown): v is string => typeof v === "string" && GMAIL_THREAD_ID.test(v);

/** `https://mail.google.com/mail/?authuser=<mailbox>#all/<thread id>`, or null when the mailbox or thread id is unusable. */
export function gmailThreadUrl(mailbox: string | null | undefined, threadId: string | null | undefined): string | null {
  if (typeof mailbox !== "string" || !MAILBOX.test(mailbox) || !isGmailThreadId(threadId)) return null;
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${threadId}`;
}
