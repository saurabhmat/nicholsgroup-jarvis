# supabase/nl (placeholder)

Reserved for the Nichols Law data plane (`SUPABASE_NL_*`, second Supabase project). It is **deferred** and out of
scope for the PKG pilot (see `docs/pilot-scope.md`). There is no `config.toml` or migration here on purpose.

When it is built it follows the same layout as `supabase/core`: `supabase/nl/supabase/{config.toml,migrations,tests}`,
because `.github/workflows/migrate-prod.yml` runs the CLI from `supabase/<project>`. Use a different `project_id` and
ports from core.
