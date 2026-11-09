// Which server the e2e run uses (H-042), read once here (scripts/ may read process.env; playwright.config.ts may not).
// E2E_SERVER=build: `next build` + `next start`; anything else (default): `next dev`. E2E_SKIP_BUILD=1 reuses .next.
export const e2eBuildMode = process.env.E2E_SERVER === "build";
export const e2eSkipBuild = process.env.E2E_SKIP_BUILD === "1";
