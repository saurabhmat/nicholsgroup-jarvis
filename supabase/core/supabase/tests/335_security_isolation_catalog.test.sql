-- T-170 (security suite), area 1 (tables and views), behavioural and catalog-driven.
-- Every table in an app schema (and the one view) is found from pg_class. Inside this rolled-back transaction the test:
--   1. drops the CHECK constraints of those tables and sets session_replication_role = replica (foreign keys and guard triggers off), only so
--      that REAL rows can be inserted for every table without building each parent chain. Row-level security, grants and policies are untouched;
--      rolled back at the end, so nothing persists;
--   2. inserts real rows for lane PKG and lane APK, for two people (the owner and the admin) per lane, per table, with the owner / connection
--      columns pointing at that person (documents of both kinds, email and Teams actions, old and new import candidates ...);
--   3. reads each table (and the view) through RLS as the real `authenticated` role with real JWT claims, as six personas: the PKG owner at AAL2
--      and AAL1, the PKG admin_technical, the PKG finance_operator, and a member of APK only (at AAL2 and AAL1);
--   4. compares what each persona SEES with what an independent, pinned oracle says they MAY see (lane membership with the pinned view of the
--      table, the role's views from core.role_views, and ownership for owner-only data). Any row seen that should not be, or any row missing, is a failure.
-- Tables that cannot be read at all by `authenticated` (private tables) are probed for refusal as authenticated and anon. A table that is neither
-- pinned, nor customised, nor private fails; seeded + private = catalog count.
begin;
select plan(17);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
delete from core.memberships where user_id = pg_temp.uid('viewer@example.test');
insert into core.memberships (lane_id, user_id, role, views) values ('APK', pg_temp.uid('viewer@example.test'), 'owner', '{}');

-- ---------------------------------------------------------------- catalog and pins
-- The role to view facts, written down here as LITERALS (the oracle uses these, not core.role_views). The catalog must equal them.
create temp table role_views_pin (role text primary key, views text[] not null) on commit drop;
insert into role_views_pin values
  ('owner', '{action_index,approvals,assistant,audit,brain,briefing,calendar,commitments,comms,config,connections,documents,finance,health,jobs,lane_policies,lanes,memberships,memory,own_mail,projects}'),
  ('admin_technical', '{action_index,config,connections,health,jobs,lane_policies,lanes,memberships,own_mail}'),
  ('finance_operator', '{action_index,assistant,finance,lanes}'),
  ('viewer', '{action_index,lanes,own_mail}');
grant all on role_views_pin to public;
select is((select coalesce(array_agg(p.role order by p.role), '{}') from role_views_pin p
           where (select array_agg(x order by x) from unnest(core.role_views(p.role)) x) is distinct from (select array_agg(x order by x) from unnest(p.views) x)), '{}'::text[],
  'the role to view mapping equals the pinned literals for every role (owner, admin_technical, finance_operator, viewer); no view is silently added to a role');
create temp table role_check on commit drop as select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'memberships_role_check';
grant all on role_check to public;
select is((select def from role_check) ~ '^CHECK \(\(role = ANY \(ARRAY\[''owner''::text, ''finance_operator''::text, ''viewer''::text, ''admin_technical''::text\]\)\)\)$', true,
  'there are exactly four roles (a new role must be pinned here)');
\ir helpers/seed_rows.psql

-- the view each standard table's policy is pinned to (what a person needs to read the table), written down independently of the policies
create temp table pin (name text primary key, view text not null) on commit drop;
insert into pin values
  ('audit.events','audit'), ('brain.document_versions','brain'), ('brain.documents','brain'), ('brain.employees','brain'), ('brain.import_candidates','brain'),
  ('brain.imports','brain'), ('brain.section_completions','brain'), ('brain.skills','brain'), ('brief.briefing_runs','own_mail'), ('brief.briefings','own_mail'),
  ('brief.news_digests','briefing'), ('cal.event_index','own_mail'), ('comms.message_index','own_mail'), ('core.connections','connections'),
  ('core.connector_api_errors','health'), ('core.job_failures','health'), ('core.lane_config','config'), ('core.lane_policies','lane_policies'),
  ('core.lanes','lanes'), ('core.memberships','memberships'), ('core.push_subscriptions','health'), ('core.sync_cursors','health'),
  ('core.sync_now_requests','health'), ('core.sync_runs','health'), ('core.users','memberships'), ('core.webhook_events','health'),
  ('fin.accounts','finance'), ('fin.bank_balances','finance'), ('fin.bills','finance'), ('fin.invoices','finance'), ('fin.normalize_runs','health'), ('fin.payments','finance'),
  ('fin.report_cache','finance'), ('fin.transactions','finance'), ('act.proposed_actions','own_mail'),
  ('act.status_history','action'), ('act.execution_claims','action'), ('comms.teams_activity','own_mail'), ('comms.teams_chat_reads','own_mail'),
  ('core.lane_config_current','config');
grant all on pin to public;
-- private tables: no column of them is readable by authenticated (reached only by definer code or the service role)
create temp table private_ok (name text primary key, why text not null) on commit drop;
insert into private_ok values
  ('core.ai_chat_rate', 'rate counter, definer code only'), ('core.ai_tool_rate', 'rate counter, definer code only'),
  ('core.connection_secrets', 'Vault references'), ('core.mfa_enrolment_state', 'MFA guard'), ('core.mfa_verification_attempts', 'MFA guard'),
  ('core.oauth_states', 'one-time OAuth state'), ('raw.source_records', 'provider payloads, service role only');
grant all on private_ok to public;

select is((select coalesce(array_agg(name order by name), '{}') from subject where not readable and name not in (select name from private_ok)), '{}'::text[],
  'every table or view that is not readable by authenticated is on the reviewed private list (checked with column-level grants too)');
select is((select coalesce(array_agg(name order by name), '{}') from subject where readable and name not in (select name from pin)), '{}'::text[],
  'every readable table or view has a pinned view in this test (a new one must be classified)');
select is((select coalesce(array_agg(name order by name), '{}') from ((select name from pin) union all (select name from private_ok)) x where name not in (select name from subject))
          || (select coalesce(array_agg(name order by name), '{}') from private_ok where name in (select name from subject where readable)), '{}'::text[],
  'no stale pin or private entry, and no private entry became readable');
select is((select count(*) filter (where readable) || '+' || count(*) filter (where not readable) || '=' || count(*) from subject), '40+7=47',
  'catalog count: 40 readable (39 tables and the view) + 7 private = 47 relations in the app schemas (a change must be classified on purpose)');

-- ---------------------------------------------------------------- the oracle
create function pg_temp.lanes_with(p_uid uuid, p_view text) returns text[] language sql as $$
  select coalesce(array_agg(m.lane_id), '{}'::text[]) from core.memberships m join core.lanes l on l.code = m.lane_id
  where m.user_id = p_uid and l.enabled and p_view = any ((select views from role_views_pin where role = m.role) || m.views);
$$;
create function pg_temp.mail_conns(p_uid uuid, p_providers text[]) returns uuid[] language sql as $$
  select coalesce(array_agg(c.id), '{}'::uuid[]) from core.connections c
  where c.owner_user_id = p_uid and c.provider = any (p_providers) and c.lane_id = any (pg_temp.lanes_with(p_uid, 'own_mail'));
$$;
-- The where-clause a person MAY see, per table (aal2). Standard tables: lane in the lanes where the person holds the pinned view.
create function pg_temp.oracle(p_name text, p_uid uuid) returns text language plpgsql as $$
declare v text := (select view from pin where name = p_name); u text := quote_literal(p_uid) || '::uuid';
begin
  return case p_name
    when 'core.lanes' then format('code = any (pg_temp.lanes_with(%s, ''lanes''))', u)
    when 'core.users' then format('id = %1$s or exists (select 1 from core.memberships m where m.user_id = users.id and m.lane_id = any (pg_temp.lanes_with(%1$s, ''memberships'')))', u)
    when 'core.memberships' then format('user_id = %1$s or lane_id = any (pg_temp.lanes_with(%1$s, ''memberships''))', u)
    when 'core.connections' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''connections'')) or (owner_user_id = %1$s and lane_id = any (pg_temp.lanes_with(%1$s, ''own_mail'')))', u)
    when 'comms.message_index' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''own_mail'')) and connection_id = any (pg_temp.mail_conns(%1$s, array[''google'', ''microsoft'']))', u)
    when 'cal.event_index' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''own_mail'')) and connection_id = any (pg_temp.mail_conns(%1$s, array[''google'', ''microsoft'']))', u)
    when 'comms.teams_chat_reads' then format('connection_id = any (pg_temp.mail_conns(%s, array[''microsoft_teams'']))', u)
    when 'comms.teams_activity' then format('connection_id = any (pg_temp.mail_conns(%s, array[''microsoft_teams'']))', u)
    when 'act.proposed_actions' then format($f$(action_type like 'email.%%' and lane_id = any (pg_temp.lanes_with(%1$s, 'own_mail')) and connection_id = any (pg_temp.mail_conns(%1$s, array['google','microsoft'])))
       or (action_type like 'teams.%%' and lane_id = any (pg_temp.lanes_with(%1$s, 'own_mail')) and connection_id = any (pg_temp.mail_conns(%1$s, array['microsoft_teams'])))
       or (action_type not like 'email.%%' and action_type not like 'teams.%%' and (lane_id = any (pg_temp.lanes_with(%1$s, 'approvals'))
            or (proposer_user_id = %1$s and lane_id = any (pg_temp.lanes_with(%1$s, 'lanes')))
            or (action_type = 'qbo.disconnect' and lane_id = any (pg_temp.lanes_with(%1$s, 'connections')))))$f$, u)
    -- history and claims follow act.action_rows_visible: email and Teams like the action row, every other type only through the approvals view
    -- (stricter than the action row itself, which also admits the proposer and the connections view: noted as F-09, not a leak)
    when 'act.status_history' then pg_temp.oracle('act.history', p_uid)
    when 'act.execution_claims' then pg_temp.oracle('act.history', p_uid)
    when 'act.history' then format($f$action_id in (select id from act.proposed_actions where
         (action_type like 'email.%%' and lane_id = any (pg_temp.lanes_with(%1$s, 'own_mail')) and connection_id = any (pg_temp.mail_conns(%1$s, array['google','microsoft'])))
         or (action_type like 'teams.%%' and lane_id = any (pg_temp.lanes_with(%1$s, 'own_mail')) and connection_id = any (pg_temp.mail_conns(%1$s, array['microsoft_teams'])))
         or (action_type not like 'email.%%' and action_type not like 'teams.%%' and lane_id = any (pg_temp.lanes_with(%1$s, 'approvals'))))$f$, u)
    when 'brain.documents' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''brain'')) and (kind not in (''about_me'', ''preferences'') or owner_user_id = %1$s)', u)
    when 'brain.document_versions' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''brain'')) and (kind not in (''about_me'', ''preferences'') or owner_user_id = %1$s)', u)
    when 'brain.imports' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''brain'')) and user_id = %1$s', u)
    when 'brain.section_completions' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''brain'')) and user_id = %1$s', u)
    when 'brain.import_candidates' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''brain'')) and user_id = %1$s and created_at > now() - interval ''24 hours''', u)
    when 'brief.briefings' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''own_mail'')) and owner_user_id = %1$s', u)
    when 'brief.briefing_runs' then format('lane_id = any (pg_temp.lanes_with(%1$s, ''own_mail'')) and owner_user_id = %1$s', u)
    when 'core.lane_config_current' then format('lane_id = any (pg_temp.lanes_with(%s, ''config''))', u)
    else format('lane_id = any (pg_temp.lanes_with(%s, %L))', u, v)
  end;
end $$;
-- an expression that identifies a row using only the columns authenticated may read
create function pg_temp.ident(p_tbl regclass) returns text language sql as $$
  select 'md5(row(' || string_agg(quote_ident(a.attname), ', ' order by a.attnum) || ')::text)'
  from pg_attribute a where a.attrelid = p_tbl and a.attnum > 0 and not a.attisdropped and has_column_privilege('authenticated', p_tbl, a.attnum, 'select');
$$;

-- ---------------------------------------------------------------- probes
create function pg_temp.sig(p_tbl regclass, p_where text) returns text language plpgsql as $$
declare v text;
begin
  execute format('select count(*) || '':'' || md5(coalesce(string_agg(h, '','' order by h), '''')) from (select %s as h from %s %s) x', pg_temp.ident(p_tbl), p_tbl, case when p_where is null then '' else 'where ' || p_where end) into v;
  return v;
end $$;
-- What the persona sees through RLS, versus what the oracle allows (computed as the superuser role with the same identity expression).
create function pg_temp.compare(p_email text, p_aal text) returns text[] language plpgsql as $$
declare v text[] := '{}'; s record; want text; got text; uid uuid := pg_temp.uid(p_email);
begin
  for s in select * from subject where readable order by name loop
    want := case when p_aal = 'aal2' then pg_temp.sig(s.tbl, pg_temp.oracle(s.name, uid)) else pg_temp.sig(s.tbl, 'false') end;
    perform pg_temp.claims(p_email, p_aal);
    set local role authenticated;
    begin
      got := pg_temp.sig(s.tbl, null);
    exception when others then got := 'error ' || sqlstate;
    end;
    reset role;
    if got is distinct from want then v := v || (s.name || ' got ' || got || ' want ' || want); end if;
  end loop;
  return v;
end $$;
-- Seeded rows a persona is expected to see (positive control: the comparison above is not vacuously empty).
create function pg_temp.sees_seeded(p_email text) returns int language plpgsql as $$
declare n int := 0; s record; c bigint; uid uuid := pg_temp.uid(p_email);
begin
  for s in select * from subject where readable and name in (select name from seeded) loop
    execute format('select count(*) from %s where %s', s.tbl, pg_temp.oracle(s.name, uid)) into c;
    n := n + (c > 0)::int;
  end loop;
  return n;
end $$;

select is(pg_temp.compare('owner@example.test', 'aal2'), '{}'::text[], 'PKG owner at AAL2: sees exactly what the oracle allows on every table and view (rows of lane APK and of the admin are not visible, own rows are)');
select is(pg_temp.compare('admin-technical@example.test', 'aal2'), '{}'::text[], 'PKG admin_technical: sees exactly what the oracle allows (no finance or brain rows, none of the owner''s mail, Teams, approvals, briefings, imports or personal documents)');
select is(pg_temp.compare('finance-operator@example.test', 'aal2'), '{}'::text[], 'PKG finance_operator: sees exactly what the oracle allows (finance, not connections, mail or brain)');
select is(pg_temp.compare('viewer@example.test', 'aal2'), '{}'::text[], 'member of APK only: sees exactly what the oracle allows (APK rows only, nothing of PKG)');
select is(pg_temp.compare('owner@example.test', 'aal1'), '{}'::text[], 'PKG owner at AAL1 (e-mail code only): sees nothing on any table or view');
select is(pg_temp.compare('viewer@example.test', 'aal1'), '{}'::text[], 'member of APK at AAL1: sees nothing on any table or view');
select cmp_ok(pg_temp.sees_seeded('owner@example.test'), '>=', 30, 'non-vacuity: the PKG owner is expected to see seeded rows on at least 30 tables');
select cmp_ok(pg_temp.sees_seeded('viewer@example.test'), '>=', 15, 'non-vacuity: the APK member is expected to see seeded rows on at least 15 tables');
select is((select count(distinct s.name)::int from seeded s join subject j on j.name = s.name where j.readable),
          (select count(*)::int from subject where readable) - 6, 'every readable table except the six fixture tables (lanes, users, memberships, policies, config, the view) was seeded with real rows: seeded + fixture = readable');

-- ---------------------------------------------------------------- private tables
create function pg_temp.denied(p_tbl regclass, p_role text) returns boolean language plpgsql as $$
declare n bigint;
begin
  execute 'set local role ' || p_role;
  begin
    execute format('select count(*) from %s', p_tbl) into n;
    reset role;
    return false;
  exception when insufficient_privilege then reset role; return true;
  end;
end $$;
select pg_temp.claims('owner@example.test', 'aal2');
select is((select coalesce(array_agg(name order by name), '{}') from subject where name in (select name from private_ok) and not (pg_temp.denied(tbl, 'authenticated') and pg_temp.denied(tbl, 'anon'))), '{}'::text[],
  'every private table refuses authenticated and anon (select count(*) raises insufficient_privilege)');
select is((select coalesce(array_agg(name order by name), '{}') from subject where anon_any), '{}'::text[], 'anon holds no privilege on any table or view');
select * from finish();
rollback;
