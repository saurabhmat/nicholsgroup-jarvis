// Side-effect module imported by the root layout. Module scope runs while `next build` collects page data, so a
// Vercel (Preview/Production) build with missing core env vars fails here with an error naming the variables
// (never values). It is a no-op in CI and local builds; see packages/core/src/env/build.ts.
import { assertBuildEnv } from "@nichols/core/env/build";

assertBuildEnv(process.env);
