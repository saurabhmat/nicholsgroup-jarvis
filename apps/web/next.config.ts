import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The client-bundle check (T-050) builds into `.next-canary` beside a running `next dev`. Only that exact value is
  // honoured, and never on Vercel: an arbitrary NEXT_DIST_DIR (say `public/x`) would publish server chunks as static files.
  ...(process.env.NEXT_DIST_DIR === ".next-canary" && !process.env.VERCEL ? { distDir: ".next-canary" } : {}),
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@nichols/connectors", "@nichols/core", "@nichols/ui"],
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
