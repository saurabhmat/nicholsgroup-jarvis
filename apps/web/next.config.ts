import type { NextConfig } from "next";

// The client-bundle check (T-050) builds into `.next-canary` beside a running `next dev`; the e2e production build
// (H-042, scripts/e2e-server.mjs) into `.next-e2e`, so it never shares output with a normal build made with real env
// values. Only these exact values are honoured, and never on Vercel: an arbitrary NEXT_DIST_DIR (say `public/x`) would
// publish server chunks as static files.
const ALLOWED_DIST_DIRS = new Set([".next-canary", ".next-e2e"]);
const distDir = process.env.NEXT_DIST_DIR;

/**
 * Headers on every response (T-299, finding F-01 of docs/security/pilot-test.md).
 *  - Referrer-Policy: the browsers' default stated explicitly: links the page opens in a new tab send only the origin, never a path or a query (a chat key, a cursor).
 *  - X-Frame-Options and `frame-ancestors`: the portal may never be shown inside a frame, by any site, itself included (it frames nothing of its own). An Approve or a Teams
 *    Send is one click for a signed-in person, so a page that could frame the portal could trick that click. Both headers are sent: `frame-ancestors` is the current rule,
 *    X-Frame-Options covers older browsers.
 *  - X-Content-Type-Options: a response is only ever what its Content-Type says.
 * This Content-Security-Policy restricts framing ONLY. A script or style policy is a separate decision (docs/plan-review.md): it is not set here.
 *
 * HOW THESE COMBINE WITH A ROUTE'S OWN HEADERS (read from Next 16's server: router-server sets the config headers on the response first, and send-response then adds a
 * handler's header only when that name is not already set): on the framework's own server the CONFIG value wins and a route's own header of the same name is DROPPED, not
 * combined. A hosting platform may apply them the other way round. So a route that needs a stricter value than the general one gets its own, later rule here (a later rule
 * replaces an earlier one for the same header name) carrying exactly the value the route itself sends: the browser then gets that value whichever side wins. Today that is
 * the Teams image route (IMAGE_ROUTE_HEADERS below; apps/web/tests/security-headers.test.ts keeps the two in step).
 */
export const SECURITY_HEADERS = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
] as const;

/** The Teams image route (T-285) answers with bytes from a chat: nothing may load or run from them, and no referrer leaves. The same values as IMAGE_HEADERS in apps/web/lib/teams-api.ts. */
export const IMAGE_ROUTE_SOURCE = "/api/lanes/:laneId/messages/image";
export const IMAGE_ROUTE_HEADERS = [
  { key: "Content-Security-Policy", value: "default-src 'none'; sandbox; frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "no-referrer" },
] as const;

const nextConfig: NextConfig = {
  ...(distDir && ALLOWED_DIST_DIRS.has(distDir) && !process.env.VERCEL ? { distDir } : {}),
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@nichols/ai", "@nichols/approvals", "@nichols/brain", "@nichols/briefing", "@nichols/connectors", "@nichols/core", "@nichols/ui"],
  experimental: {
    agentFeedback: true,
  },
  // Every response (pages, API routes, static files), then the stricter values of the one route that has its own: see SECURITY_HEADERS above. Order matters: later wins.
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
      { source: IMAGE_ROUTE_SOURCE, headers: [...IMAGE_ROUTE_HEADERS] },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
