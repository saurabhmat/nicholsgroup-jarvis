// Runs once when the Next.js SERVER starts (not during `next build`; app/env-check.ts covers the build).
// Two checks, split on purpose:
//  - build time (app/env-check.ts): a bad deployment never ships;
//  - server start (here): a bad runtime env crashes the server at boot instead of failing on first request.
// A missing core variable on a real deployment (VERCEL=1) therefore stops the server at boot.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertBuildEnv } = await import("@nichols/core/env/build");
    const { warnUnconfiguredFeatures } = await import("@nichols/core/env/startup");
    assertBuildEnv(process.env);
    warnUnconfiguredFeatures(process.env);
    const { installFetchTiming } = await import("./lib/server-timing-fetch");
    installFetchTiming(); // T-230 A: only in dev or with SERVER_TIMING=1; counts Supabase round trips by name
  }
}
