-- Harness smoke test (T-006). Proves `supabase test db` runs pgTAP against the local core DB.
-- No app tables exist yet; table, RLS and cross-lane tests start with T-010.
begin;
select plan(4);

select has_extension('pgtap', 'pgTAP extension is available');
select has_schema('public', 'public schema exists');
select has_schema('auth', 'Supabase auth schema exists');
select is((select current_setting('server_version_num')::int >= 170000), true, 'Postgres major version is 17 or newer');

select * from finish();
rollback;
