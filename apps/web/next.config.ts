import type { NextConfig } from "next";

// The client-bundle check (T-050) builds into `.next-canary` beside a running `next dev`; the e2e production build
// (H-042, scripts/e2e-server.mjs) into `.next-e2e`, so it never shares output with a normal build made with real env
// values. Only these exact values are honoured, and never on Vercel: an arbitrary NEXT_DIST_DIR (say `public/x`) would
// publish server chunks as static files.
const ALLOWED_DIST_DIRS = new Set([".next-canary", ".next-e2e"]);
const distDir = process.env.NEXT_DIST_DIR;

const nextConfig: NextConfig = {
  ...(distDir && ALLOWED_DIST_DIRS.has(distDir) && !process.env.VERCEL ? { distDir } : {}),
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@nichols/ai", "@nichols/brain", "@nichols/connectors", "@nichols/core", "@nichols/ui"],
  experimental: {
    agentFeedback: true,
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
