// The chat in the page address (T-283, spec 11): `?chat=<base64url of the Graph chat id>`. A chat id is `19:...@thread.v2`: colons and an `@` in a URL are awkward and look like content, so the id is
// encoded; decoding VALIDATES it (the same format the Teams client checks before any request), so a made-up key is "no chat selected" and never reaches Graph. Plain functions (no directive):
// used by server and client components.
const CHAT_ID = /^19:[A-Za-z0-9._@:-]{1,197}$/; // at most 200 characters in all (the database's bound too)
const KEY = /^[A-Za-z0-9_-]{1,300}$/;

export const isChatId = (v: unknown): v is string => typeof v === "string" && CHAT_ID.test(v);

export function encodeChatKey(chatId: string): string {
  if (!isChatId(chatId)) throw new Error("not a chat id");
  return btoa(chatId).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The chat id for a key, or null for anything that is not exactly an encoded, valid chat id. */
export function decodeChatKey(key: unknown): string | null {
  if (typeof key !== "string" || !KEY.test(key)) return null;
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    const id = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return isChatId(id) && encodeChatKey(id) === key ? id : null; // canonical form only: one key per chat
  } catch {
    return null;
  }
}
