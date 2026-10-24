import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@nichols/core"],
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
