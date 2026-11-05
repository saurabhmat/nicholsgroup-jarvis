# Core database (Supabase)

Local only for agents: `pnpm db:start`, `pnpm db:reset` (regenerates the seed, then resets), `pnpm test:db` (pgTAP),
`pnpm db:types`. Agents never apply migrations to a cloud project.

## Lane conventions (T-010 – T-013)

- **Lanes.** `core.lanes` is keyed by `code` (`'PKG'`). Every lane-scoped table has `lane_id text not null references
  core.lanes (code)`.
- **Who sees what.** `core.memberships` gives each user one role per lane (owner, finance_operator, viewer,
  admin_technical). `core.role_views(role)` lists the views a role gets; viewers also get the named views on their
  membership (`core.viewer_view_names()`). All view names are in `core.view_names()`.
- **The policy.** Every lane-scoped table uses the standard SELECT policy:
  `(select auth.jwt() ->> 'aal') = 'aal2' and lane_id = any ((select core.allowed_lanes((select auth.uid()), '<view>'))::text[])`.
  `core.allowed_lanes()` answers only for the caller's own uid at AAL2 (service_role: any uid) and only for enabled
  lanes. For actions a view does not imply (e.g. finance sign-off), use `core.has_lane_role(uid, lane, roles)`.
- **Grants.** No privileges for `anon`. `authenticated` reads only (writes go through service-role code or
  security-definer functions). Views are `security_invoker = true`. Every function sets `search_path = ''` and
  schema-qualifies its references; `anon` cannot execute any of them.
- **New table.** Start from [`templates/lane_table.sql`](templates/lane_table.sql). Add pgTAP tests in the same change,
  including a cross-lane denial test; `pg_temp.has_standard_lane_policy(table, view)` from
  `supabase/tests/helpers/lane_rls.psql` checks the policy.
- **Catalog test.** `supabase/tests/050_catalog.test.sql` fails when any table, view, sequence or function in an app
  schema breaks these rules. App schemas are all schemas except the Supabase/Postgres platform ones, so a new schema
  is covered automatically. Lane tables must have exactly one permissive policy, equal to the canonical expression
  (compared as a whole, never by fragment). It also checks column-level grants, write policies, materialized views,
  sequences, security-definer functions and what `authenticated` may execute. Exceptions (`no_lane_id_ok`,
  `custom_policy_ok`, `user_dml_ok`, `unprotected_read_ok`, `security_definer_ok`, `authenticated_exec_ok`) are
  reviewed lists with a reason per entry; a new security-definer function or callable function must be added there.

- **Finance (`fin`, T-055).** Six ledger/report tables on the `finance` view; rows tie to a same-lane QuickBooks connection and
  raw record by composite FKs. Not exposed to PostgREST yet (T-081). See `.agent/pr/T-055.md`.
- **Comms and calendar index (`comms.message_index`, `cal.event_index`, T-061).** Metadata only: no body, snippet or description column (pgTAP-enforced); `summary` needs an approval marker. Owner-only `comms` view, `calendar` view for `cal`. Same-lane Google/Microsoft connection by composite FK; service_role writes; per-lane retention via `comms.message_index_purge` (lane policy `retention_days`) and `cal.event_index_purge` (180 days). Schemas not exposed to PostgREST yet. See `.agent/pr/T-061.md`.

## Tests

`supabase/tests/*.test.sql`, one transaction each, rolled back. Include the shared helpers with
`\ir helpers/lane_rls.psql` (persona claims, `pg_temp.uid()`, `pg_temp.lanes_for()`, the policy check).

## Seed data

Synthetic only; see "Seed data" in the root README. Sections live in `seed/sections/`; `seed.sql` is generated.
