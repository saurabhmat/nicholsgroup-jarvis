/**
 * A provider URL we may render as a link (rule 9: provider data is untrusted). Parsed once; only `https:` with no
 * credentials ("https://meet.google.com@evil.test" is a link to evil.test); returns the normalised href, else null.
 */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null;
    return u.href;
  } catch {
    return null;
  }
}
