// T-230 A: counts the server's round trips to Supabase while timing is on (dev or SERVER_TIMING=1): one log line per
// call, `[timing] {"name":"net.rest.<table or rpc.fn>"|"net.auth.<endpoint>","at","ms"}`. The name comes from the fixed
// path shape of the Supabase API (table or function name, auth endpoint), never from query strings, headers, bodies or ids.
import { safeName, timingEnabled } from "./server-timing";

/** `net.rest.lanes`, `net.rest.rpc.has_lane_role`, `net.auth.user`; null for a URL that is not the Supabase API. */
export function spanNameFor(url: string, supabaseUrl: string): string | null {
  if (!supabaseUrl || !url.startsWith(supabaseUrl)) return null;
  const path = url.slice(supabaseUrl.length).split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "auth" && parts[1] === "v1") return safeName(`net.auth.${parts[2] ?? "x"}`);
  if (parts[0] === "rest" && parts[1] === "v1") return safeName(parts[2] === "rpc" ? `net.rest.rpc.${parts[3] ?? "x"}` : `net.rest.${parts[2] ?? "x"}`);
  return `net.other`;
}

export function installFetchTiming(): void {
  if (!timingEnabled()) return;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = spanNameFor(url, supabaseUrl);
    if (!name) return original(input, init);
    const at = Date.now();
    const start = performance.now();
    try {
      return await original(input, init);
    } finally {
      console.info(`[timing] ${JSON.stringify({ name, at, ms: Math.round((performance.now() - start) * 10) / 10 })}`);
    }
  };
}
