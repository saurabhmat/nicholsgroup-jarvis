import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // `NEXT_DIST_DIR` lets the client-bundle check (T-050) build beside a running `next dev` without touching its output.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
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
