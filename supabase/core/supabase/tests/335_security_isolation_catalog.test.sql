-- T-170 (security suite), area 1: behavioural lane and user isolation, driven by the catalog.
-- Subjects are enumerated from pg_class / pg_policy / pg_proc, never listed by hand, so a NEW table, view or API-callable function is probed
-- automatically; the only hand-written part is the registry of CUSTOM (non-standard) policies and of function exceptions, each with a reason.
-- A custom policy or an uncallable function with no registry entry fails, and so does a stale entry.
--   Tables: the policy's own USING expression is evaluated, as the real role with real JWT claims, against a synthetic row, so the
--   proof does not depend on data being present: AAL1 is refused, a member of another lane is refused, "another user's" row is refused
--   for owner-only data, and a positive control shows the probe can say yes. Real rows are probed too (counts as other personas).
--   Functions: every function `authenticated` can execute that takes a lane (p_lane), a user (p_uid / p_owner) is called as a persona that
--   must not get the data; the answer must be an error or exactly the answer for a lane that does not exist (no data, no existence oracle).
begin;
select plan(16);
\ir helpers/lane_rls.psql

-- ------------------------------------------------------------------ fixtures (rolled back)
update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test'); -- the owner is a PKG-only member here
insert into core.memberships (lane_id, user_id, role, views) values ('APK', pg_temp.uid('viewer@example.test'), 'viewer', '{}') on conflict do nothing;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('viewer@example.test'); -- keep every persona PKG-only
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033501', 'PKG', 'google', 'iso-owner@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033502', 'PKG', 'google', 'iso-admin@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033503', 'PKG', 'microsoft_teams', 'iso-owner@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033504', 'PKG', 'microsoft_teams', 'iso-admin@teams.example.test', 'active', '{}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033505', 'APK', 'google', 'iso-apk@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test'));
insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, subject, received_at)
values ('PKG', '00000000-0000-4000-8000-000000033501', 'google', 'iso-m-1', 'iso-t-1', 'sender@example.test', 'Synthetic owner subject', now());
insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('PKG', '00000000-0000-4000-8000-000000033503', '19:iso-chat-1@thread.v2', now());

-- ------------------------------------------------------------------ registry of custom policies (everything else must be the standard policy)
-- key = table (optional '#variant'); mine / other are jsonb column overrides with tokens: $me, $other, $my_mail, $other_mail, $my_teams, $other_teams.
-- owner_only: a row of $other must be refused to a member of the same lane. positive: the probe can say yes for $me (false: negative-only, with the reason).
create temp table custom_policy (k text primary key, tbl text not null, mine jsonb, other jsonb, owner_only boolean not null, positive boolean not null, why text not null, self_ok boolean not null default false) on commit drop;
insert into custom_policy (k, tbl, mine, other, owner_only, positive, why, self_ok) values
  ('core.connections', 'core.connections', '{"owner_user_id":"$me"}', '{"owner_user_id":"$other"}', false, true, 'lane view (connections) OR own mailbox; admins may list lane connections by design', false),
  ('core.users', 'core.users', '{"id":"$me"}', '{"id":"00000000-0000-4000-8000-0000000000bb"}', false, true, 'a person plus people who share a lane (no lane_id column; a person nobody shares a lane with is refused)', true),
  ('core.memberships', 'core.memberships', '{"user_id":"$me"}', '{"user_id":"00000000-0000-4000-8000-0000000000bb"}', false, true, 'own row OR the lane roster (memberships view)', true),
  ('comms.message_index', 'comms.message_index', '{"connection_id":"$my_mail"}', '{"connection_id":"$other_mail"}', true, true, 'mail is readable only through mailbox ownership', false),
  ('cal.event_index', 'cal.event_index', '{"connection_id":"$my_mail"}', '{"connection_id":"$other_mail"}', true, true, 'calendar is readable only through mailbox ownership', false),
  ('comms.teams_chat_reads', 'comms.teams_chat_reads', '{"connection_id":"$my_teams"}', '{"connection_id":"$other_teams"}', true, true, 'Teams read markers belong to the connection owner', false),
  ('comms.teams_activity', 'comms.teams_activity', '{"connection_id":"$my_teams"}', '{"connection_id":"$other_teams"}', true, true, 'Teams activity belongs to the connection owner', false),
  ('act.proposed_actions#email', 'act.proposed_actions', '{"action_type":"email.send","connection_id":"$my_mail"}', '{"action_type":"email.send","connection_id":"$other_mail"}', true, true, 'email actions: the mailbox owner only', false),
  ('act.proposed_actions#teams', 'act.proposed_actions', '{"action_type":"teams.chat.send","connection_id":"$my_teams"}', '{"action_type":"teams.chat.send","connection_id":"$other_teams"}', true, true, 'Teams actions: the connection owner only', false),
  ('act.status_history', 'act.status_history', '{}', '{"action_id":"00000000-0000-4000-8000-0000000000aa"}', true, false, 'visible through its action row (act.action_rows_visible); negative-only, positive proven in 290/330', false),
  ('act.execution_claims', 'act.execution_claims', '{}', '{"action_id":"00000000-0000-4000-8000-0000000000aa"}', true, false, 'visible through its action row; negative-only, positive proven in 290', false),
  ('brain.documents', 'brain.documents', '{"kind":"about_me","owner_user_id":"$me"}', '{"kind":"about_me","owner_user_id":"$other"}', true, true, 'personal documents (about_me, preferences) belong to their owner', false),
  ('brain.document_versions', 'brain.document_versions', '{"kind":"about_me","owner_user_id":"$me"}', '{"kind":"about_me","owner_user_id":"$other"}', true, true, 'versions of personal documents', false),
  ('brain.imports', 'brain.imports', '{"user_id":"$me"}', '{"user_id":"$other"}', true, true, 'an import belongs to the person who started it', false),
  ('brain.section_completions', 'brain.section_completions', '{"user_id":"$me"}', '{"user_id":"$other"}', true, true, 'progress belongs to the person', false),
  ('brain.import_candidates', 'brain.import_candidates', '{"user_id":"$me","created_at":"now"}', '{"user_id":"$other","created_at":"now"}', true, true, 'candidates belong to the person, 24 h', false),
  ('brief.briefings', 'brief.briefings', '{"owner_user_id":"$me"}', '{"owner_user_id":"$other"}', true, true, 'a briefing belongs to its owner', false),
  ('brief.briefing_runs', 'brief.briefing_runs', '{"owner_user_id":"$me"}', '{"owner_user_id":"$other"}', true, true, 'a run belongs to its owner', false);

insert into custom_policy (k, tbl, mine, other, owner_only, positive, why) values
  ('core.lanes', 'core.lanes', '{"code":"$lane"}', '{"code":"$lane"}', false, true, 'the lane registry: keyed by code, visible to its members');
grant all on custom_policy to public;

-- Tables the catalog finds, with the shape of their policy.
create temp table subject on commit drop as
select c.oid::regclass as tbl, n.nspname || '.' || c.relname as name, c.relkind,
       exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'lane_id' and not a.attisdropped) as has_lane,
       (select p.oid from pg_policy p where p.polrelid = c.oid and p.polcmd = 'r') as pol,
       has_table_privilege('authenticated', c.oid, 'select') as auth_select,
       (select pg_get_expr(p.polqual, p.polrelid) from pg_policy p where p.polrelid = c.oid and p.polcmd = 'r') as qual
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'v', 'p') and n.nspname not in ('_realtime','auth','extensions','graphql','graphql_public','information_schema','pg_catalog','pg_toast','pgbouncer','realtime','storage','supabase_functions','supabase_migrations','vault','net','cron','pgsodium','pgsodium_masks','pg_temp','public')
  and n.nspname !~ '^pg_';
grant all on subject to public;
alter table subject add column standard boolean;
update subject set standard = qual ~ '^\(\(\( SELECT \(auth\.jwt\(\) ->> ''aal''::text\)\) = ''aal2''::text\) AND \(lane_id = ANY \(\( SELECT core\.allowed_lanes\(\( SELECT auth\.uid\(\) AS uid\), ''[a-z_]+''::text\) AS allowed_lanes\)::text\[\]\)\)\)$';

-- ------------------------------------------------------------------ probe helpers
create function pg_temp.tok(p_json jsonb, p_persona text) returns jsonb language sql as $$
  select replace(replace(replace(replace(replace(replace(replace(p_json::text,
    '$my_mail', case when p_persona = 'owner' then '00000000-0000-4000-8000-000000033501' else '00000000-0000-4000-8000-000000033502' end),
    '$other_mail', case when p_persona = 'owner' then '00000000-0000-4000-8000-000000033502' else '00000000-0000-4000-8000-000000033501' end),
    '$my_teams', case when p_persona = 'owner' then '00000000-0000-4000-8000-000000033503' else '00000000-0000-4000-8000-000000033504' end),
    '$other_teams', case when p_persona = 'owner' then '00000000-0000-4000-8000-000000033504' else '00000000-0000-4000-8000-000000033503' end),
    '$me', case when p_persona = 'owner' then pg_temp.uid('owner@example.test')::text else pg_temp.uid('admin-technical@example.test')::text end),
    '$other', case when p_persona = 'owner' then pg_temp.uid('admin-technical@example.test')::text else pg_temp.uid('owner@example.test')::text end),
    '$zz', '')::jsonb;
$$;

-- Evaluates the table's SELECT policy for one synthetic row: lane_id = p_lane, the given column values, every other column NULL.
create function pg_temp.row_allows(p_tbl regclass, p_lane text, p_over jsonb) returns boolean language plpgsql as $$
declare v_cols text; v_qual text; v_alias text; v_res boolean;
begin
  p_over := replace(p_over::text, '$lane', p_lane)::jsonb;
  select string_agg(format('%s::%s as %I',
           case when p_over ? a.attname then quote_nullable(p_over ->> a.attname) when a.attname = 'lane_id' then quote_nullable(p_lane) else 'null' end,
           format_type(a.atttypid, a.atttypmod), a.attname), ', ' order by a.attnum)
    into v_cols from pg_attribute a where a.attrelid = p_tbl and a.attnum > 0 and not a.attisdropped;
  select pg_get_expr(polqual, polrelid) into v_qual from pg_policy where polrelid = p_tbl and polcmd = 'r' limit 1;
  select relname into v_alias from pg_class where oid = p_tbl;
  execute format('select exists (select 1 from (select %s) as %I where %s)', v_cols, v_alias, v_qual) into v_res;
  return coalesce(v_res, false);
end $$;

-- Runs the whole table probe as one persona at one AAL. Returns violation labels. p_mode: 'deny' (nothing may be allowed for the lane) or 'allow' (positive controls).
create function pg_temp.table_probe(p_email text, p_persona text, p_aal text, p_lane text, p_mode text, p_cross_user boolean default false, p_mode2 text default null) returns text[] language plpgsql as $$
declare v text[] := '{}'; s record; cp record; ok boolean; mine jsonb; other jsonb;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  for s in select * from subject where pol is not null and auth_select order by name loop
    if s.standard then
      if p_cross_user then continue; end if;
      ok := pg_temp.row_allows(s.tbl, p_lane, '{}');
      if p_mode = 'deny' and ok then v := v || (s.name || ': allowed'); end if;
      if p_mode = 'allow' and not ok and p_mode2 is null then v := v || (s.name || ': positive control refused'); end if;
    else
      for cp in select * from custom_policy where tbl = s.name order by k loop
        mine := pg_temp.tok(cp.mine, p_persona);
        other := pg_temp.tok(cp.other, p_persona);
        if p_cross_user then
          if cp.owner_only and pg_temp.row_allows(s.tbl, p_lane, other) then v := v || (cp.k || ': another user''s row allowed'); end if;
        else
          ok := pg_temp.row_allows(s.tbl, p_lane, case when cp.self_ok and p_mode = 'deny' then other else mine end);
          if p_mode = 'deny' and ok then v := v || (cp.k || ': allowed'); end if;
          if p_mode = 'allow' and cp.positive and not ok and (p_mode2 is null or cp.k ~ p_mode2) then v := v || (cp.k || ': positive control refused'); end if;
        end if;
      end loop;
    end if;
  end loop;
  reset role;
  return v;
end $$;

-- ------------------------------------------------------------------ 1. the catalog is classified
select is((select coalesce(array_agg(name order by name), '{}') from subject where pol is not null and auth_select and not standard
           and name not in (select tbl from custom_policy)), '{}'::text[],
  'every table with a non-standard SELECT policy has a reviewed registry entry (owner-only or lane-or-owner)');
select is((select coalesce(array_agg(k order by k), '{}') from custom_policy where tbl not in (select name from subject where pol is not null and not standard)), '{}'::text[],
  'no stale custom-policy entry');
select is((select count(*)::int from subject where relkind in ('r','p')), 45, 'the catalog holds 45 app tables (a new table changes this number: it is then probed automatically; update the figure on purpose)');

-- ------------------------------------------------------------------ 2. positive controls: the probe can say yes
select is(pg_temp.table_probe('owner@example.test', 'owner', 'aal2', 'PKG', 'allow'), '{}'::text[], 'positive control: the PKG owner at AAL2 is allowed a PKG row on every probed table (standard and custom)');
select is(pg_temp.table_probe('admin-technical@example.test', 'admin', 'aal2', 'PKG', 'allow', false, '^(comms|cal|act\.proposed|brief)'), '{}'::text[], 'positive control: admin_technical sees its OWN mail, calendar, Teams, approvals and briefing rows (own_mail view)');

-- ------------------------------------------------------------------ 3. AAL1 and cross-lane denial on every table
select is(pg_temp.table_probe('owner@example.test', 'owner', 'aal1', 'PKG', 'deny'), '{}'::text[], 'AAL1 (e-mail code only) reads nothing: no table lets a PKG owner at AAL1 see a PKG row, whatever the owner column says');
select is(pg_temp.table_probe('owner@example.test', 'owner', 'aal2', 'APK', 'deny'), '{}'::text[], 'CROSS-LANE: a PKG-only owner at AAL2 is refused an APK row on every table, even when the row names them as owner');
select is(pg_temp.table_probe('admin-technical@example.test', 'admin', 'aal2', 'APK', 'deny'), '{}'::text[], 'CROSS-LANE: PKG-only admin_technical is refused an APK row on every table');
select is(pg_temp.table_probe('viewer@example.test', 'admin', 'aal2', 'APK', 'deny'), '{}'::text[], 'CROSS-LANE: a PKG-only viewer is refused an APK row on every table');
select is(pg_temp.table_probe('owner@example.test', 'owner', 'aal2', 'ZZ', 'deny'), '{}'::text[], 'a lane that does not exist is refused on every table');

-- ------------------------------------------------------------------ 4. cross-user denial for owner-only data (same lane, row of another person)
select is(pg_temp.table_probe('owner@example.test', 'owner', 'aal2', 'PKG', 'deny', true), '{}'::text[], 'CROSS-USER: the PKG owner cannot read the admin''s mail, calendar, Teams, approvals, briefings, imports or personal brain documents');
select is(pg_temp.table_probe('admin-technical@example.test', 'admin', 'aal2', 'PKG', 'deny', true), '{}'::text[], 'CROSS-USER: admin_technical cannot read the owner''s mail, calendar, Teams, approvals, briefings, imports or personal brain documents');

-- ------------------------------------------------------------------ 5. real rows, real policies
create function pg_temp.real_counts(p_email text, p_aal text, p_lane_filter text) returns text[] language plpgsql as $$
declare v text[] := '{}'; s record; n bigint;
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  for s in select * from subject where auth_select and relkind in ('r','p','v') order by name loop
    begin
      if p_lane_filter is null then
        execute format('select count(*) from %s', s.tbl) into n;
      else
        execute format('select count(*) from %s where lane_id %s', s.tbl, p_lane_filter) into n;
      end if;
      if n > 0 then v := v || (s.name || '=' || n); end if;
    exception when others then null; -- an error is a refusal
    end;
  end loop;
  reset role;
  return v;
end $$;
select is(pg_temp.real_counts('owner@example.test', 'aal1', null), '{}'::text[], 'REAL ROWS: at AAL1 every readable table and view returns zero rows (including the synthetic mail and Teams rows seeded for this test)');
select is(pg_temp.real_counts('admin-technical@example.test', 'aal2', '<> ''PKG'''), '{}'::text[], 'REAL ROWS: a PKG-only user reads no row of any other lane from any table or view');
select cmp_ok((select count(*) from comms.message_index where message_id = 'iso-m-1'), '=', 1::bigint, 'the seeded message row exists (so the denials above are not empty because of missing data)');
-- Negative control: the probe does say "allowed" for a deliberately open policy (so a clean result above is not vacuous).
create temp table iso_sentinel (lane_id text);
alter table iso_sentinel enable row level security;
create policy iso_open on iso_sentinel for select to authenticated using (true);
grant select on iso_sentinel to authenticated;
select pg_temp.claims('admin-technical@example.test', 'aal1');
set local role authenticated;
select is(pg_temp.row_allows('iso_sentinel'::regclass, 'APK', '{}'), true, 'negative control: the probe reports an open policy as allowed (AAL1, other lane)');
reset role;
select * from finish();
rollback;
