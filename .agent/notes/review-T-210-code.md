# T-210 code review (self-review; the code-reviewer subagent could not be started from the build agent)

- Module shape matches the others (domain/tools/jobs/ui + server subpath); root export is client-safe; `server` and `jobs` take an injected client factory, so there is no direct Supabase import and tests need no network.
- Types: wrappers are called through the same untyped `rpc` cast the retention store uses (db types are generated and not regenerated here); replies are validated field by field and a malformed reply is `invalid`, not trusted.
- `templates.generated.ts` is generated and a unit test fails when it is stale; the README is excluded.
- apps/web: the Inngest route now depends on `@nichols/brain` (allow-list, transpilePackages, lockfile updated) only to wire `createImportPurge`.
- Fixed during build: lint (unused params), a looser test expectation (Fine.md), `checkText` leftover param.
- MEDIUM: `ensureSeeds` makes up to ~6 sequential RPCs on first use (fine for a one-time setup); documents list capped at 500 (the brain is small by design). LOW: `findHomeLane` takes any open lane because the wrapper is not lane-specific.
- Tests: brain 36 (domain 14, store 17, jobs 2, boundaries 2, index 1), core +5 (import purge), pgTAP 125, plus allow-list and catalog.
