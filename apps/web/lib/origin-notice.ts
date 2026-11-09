// "You're on <host>. Open <app URL> to connect accounts." (T-226). Connecting only works on the app's own origin
// (NEXT_PUBLIC_APP_URL): the OAuth redirect and the same-origin check both use it. This decides whether the Settings page
// was opened on a different host. Hosts only: no path, query, user info or other env value ever reaches the page.

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

/** A lower-case host[:port] from a Host or X-Forwarded-Host header value, or null when it is not a plain host. */
export function plainHost(raw: string | null | undefined): string | null {
  const first = raw?.split(",")[0]?.trim().toLowerCase();
  return first && first.length <= 255 && HOST.test(first) ? first : null;
}

export type OriginNotice = { currentHost: string; appHost: string; appUrl: string };

/** Null when the hosts match, when either cannot be read, or when the app URL is not an http(s) URL. */
export function originNotice(currentHostHeader: string | null | undefined, appUrl: string | undefined): OriginNotice | null {
  const current = plainHost(currentHostHeader);
  if (!current || !appUrl || !URL.canParse(appUrl)) return null;
  const app = new URL(appUrl);
  if (app.protocol !== "https:" && app.protocol !== "http:") return null;
  const appHost = plainHost(app.host);
  if (!appHost) return null;
  // Default ports are dropped by URL; a header may carry them.
  const strip = (h: string) => h.replace(/:(80|443)$/, "");
  if (strip(current) === strip(appHost)) return null;
  return { currentHost: current, appHost, appUrl: app.origin };
}
