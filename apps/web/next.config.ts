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
 * This Content-Security-Policy restricts framing ONLY. A script or style policy is a separate decision (docs/plan-review.md): it is not set here. A route that sends its own
 * stricter policy (the Teams image route) repeats `frame-ancestors 'none'` in it, so framing is refused whichever of the two headers a browser honours.
 */
export const SECURITY_HEADERS = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
] as const;

const nextConfig: NextConfig = {
  ...(distDir && ALLOWED_DIST_DIRS.has(distDir) && !process.env.VERCEL ? { distDir } : {}),
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@nichols/ai", "@nichols/approvals", "@nichols/brain", "@nichols/briefing", "@nichols/connectors", "@nichols/core", "@nichols/ui"],
  experimental: {
    agentFeedback: true,
  },
  // Every response (pages, API routes, static files): see SECURITY_HEADERS above.
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
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
