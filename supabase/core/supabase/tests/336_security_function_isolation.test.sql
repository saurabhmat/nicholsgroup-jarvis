-- T-170 (security suite), area 1 (functions). Every function in an app schema that `authenticated` can execute is found from pg_proc and called
-- against REAL rows (helpers/seed_rows.psql: both lanes, two people per lane, ids of every kind), as personas that must not get the data:
--   * CROSS-LANE: a PKG-only owner calls with lane APK and the REAL ids of APK rows. The answer (SQLSTATE and message, ids and lane masked) must be
--     identical to the answer for a lane that does not exist (no existence oracle), must contain no APK row id, and must change no row;
--   * AAL1: the PKG owner without the second factor, lane PKG and own ids: the same identity with the missing-lane answer, no row changed;
--   * CROSS-USER: admin_technical calls lane PKG with the OWNER's real ids (connection, action, import, run, thread ...): no id of the owner's
--     rows in the answer and no row changed;
--   * USER PARAMETER: asking about another person gives the answer for an unknown person.
-- "No row changed" is measured with the transaction-local table statistics (inserts, updates, deletes across the app schemas) around each call.
-- Functions with no lane or user parameter must be on a reviewed list with a reason (pure helpers); a stale entry fails.
-- Non-vacuity: the legitimate owner's call differs from the missing-lane answer for many functions (the probes reach data).
begin;
select plan(14);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
delete from core.memberships where user_id = pg_temp.uid('viewer@example.test');
insert into core.memberships (lane_id, user_id, role, views) values ('APK', pg_temp.uid('viewer@example.test'), 'owner', '{}');
-- Mirror the PKG lane's settings into APK so every function has real settings to (wrongly) reveal there.
update core.lane_policies a set llm_allowed_categories = p.llm_allowed_categories, write_actions_allowed = p.write_actions_allowed, store_outbound_drafts = true
  from core.lane_policies p where p.lane_id = 'PKG' and a.lane_id = 'APK';
insert into core.lane_config (lane_id, version, config)
select 'APK', (select coalesce(max(version), 0) + 1 from core.lane_config where lane_id = 'APK'), config from core.lane_config where lane_id = 'PKG' order by version desc limit 1;
\ir helpers/seed_rows.psql

create temp table no_subject_ok (sig text primary key, why text not null) on commit drop;
insert into no_subject_ok values
  ('act.is_email_type(text)', 'pure classifier of a type string'),
  ('act.is_teams_type(text)', 'pure classifier of a type string'),
  ('act.is_unknown_failure(text)', 'pure classifier of a failure code'),
  ('act.action_rows_visible(uuid)', 'RLS helper keyed by an action id: checked below with real ids (true only for the caller''s own rows)'),
  ('core.brain_home_lane()', 'returns the configured home lane code, no lane data'),
  ('core.role_views(text)', 'static role to view map'), ('core.view_names()', 'static list of view names'), ('core.viewer_view_names()', 'static list of view names'),
  ('fin.business_week(timestamp with time zone)', 'pure date helper'), ('fin.et_date(timestamp with time zone)', 'pure date helper'),
  ('fin.month_range(date)', 'pure date helper'), ('fin.month_start(date)', 'pure date helper'), ('fin.mtd_range(timestamp with time zone)', 'pure date helper'),
  ('fin.next_month_start(date)', 'pure date helper'), ('fin.ytd_range(date)', 'pure date helper'), ('fin.ytd_start(date)', 'pure date helper');
grant all on no_subject_ok to public;

-- Functions that write a row for the CALLER regardless of whose ids are passed (their arguments carry no other person's id): a one-time OAuth state and the
-- caller's own rate counters. Reviewed; a stale entry (the function no longer writes) is not checked, because the write depends on the caller's state.
create temp table self_writer (name text primary key, why text not null) on commit drop;
insert into self_writer values
  ('core.oauth_state_create', 'creates the caller''s own one-time OAuth state'),
  ('core.ai_chat_turn', 'the caller''s own chat rate counter'),
  ('core.ai_tool_gate', 'the caller''s own tool rate counter'),
  ('core.news_begin_refresh', 'reserves the caller''s lane news refresh budget (owner action on its own lane)'),
  ('core.briefing_save_own', 'saves the caller''s own briefing (one per owner and lane; too_soon on repeat)'),
  ('core.sync_now_claim', 'the caller''s own sync-now rate claim');
grant all on self_writer to public;

create temp table fn on commit drop as
select p.oid as oid, p.oid::regprocedure::text as sig, n.nspname || '.' || p.proname as name,
       (p.proargnames && array['p_lane', 'p_lane_id']) as has_lane, (p.proargnames && array['p_uid', 'p_owner']) as has_user
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute');
grant all on fn to public;

-- Ids of real rows per (lane, person).
create temp table idmap (lane text, who text, uid uuid, conn uuid, tconn uuid, act uuid, imp uuid, run uuid, news uuid, doc_path text, thread text, msg text, primary key (lane, who));
grant all on idmap to public;
insert into idmap
select l.lane, w.who, pg_temp.uid(w.email),
  (select id from core.connections c where c.lane_id = l.lane and c.owner_user_id = pg_temp.uid(w.email) and c.provider = 'google' and c.external_account_id like 'iso-%' limit 1),
  (select id from core.connections c where c.lane_id = l.lane and c.owner_user_id = pg_temp.uid(w.email) and c.provider = 'microsoft_teams' and c.external_account_id like 'iso-%' limit 1),
  (select id from act.proposed_actions a where a.lane_id = l.lane and a.proposer_user_id = pg_temp.uid(w.email) and a.action_type = 'email.send' limit 1),
  (select id from brain.imports i where i.lane_id = l.lane and i.user_id = pg_temp.uid(w.email) limit 1),
  (select id from brief.briefing_runs r where r.lane_id = l.lane and r.owner_user_id = pg_temp.uid(w.email) limit 1),
  (select id from brief.news_digests d where d.lane_id = l.lane limit 1),
  (select path from brain.documents d where d.lane_id = l.lane and d.owner_user_id = pg_temp.uid(w.email) limit 1),
  (select thread_id from comms.message_index m where m.lane_id = l.lane and m.connection_id = (select id from core.connections c where c.lane_id = l.lane and c.owner_user_id = pg_temp.uid(w.email) and c.provider = 'google' and c.external_account_id like 'iso-%' limit 1) limit 1),
  (select message_id from comms.message_index m where m.lane_id = l.lane and m.connection_id = (select id from core.connections c where c.lane_id = l.lane and c.owner_user_id = pg_temp.uid(w.email) and c.provider = 'google' and c.external_account_id like 'iso-%' limit 1) limit 1)
from (values ('PKG'), ('APK')) l(lane) cross join (values ('owner', 'owner@example.test'), ('admin', 'admin-technical@example.test')) w(who, email);

-- "Nothing there": ids that exist nowhere, per lane (the answer for another person's REAL ids must be the same as for these).
insert into idmap (lane, who, uid, conn, tconn, act, imp, run, news, doc_path, thread, msg)
select l.lane, 'none', '00000000-0000-4000-8000-0000000000dd', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'no-such-path', 'no-such-thread', 'no-such-message'
from (values ('PKG'), ('APK')) l(lane);

create function pg_temp.writes() returns bigint language sql as $$
  select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint from pg_stat_xact_all_tables where schemaname in ('act','audit','brain','brief','cal','comms','core','fin','raw');
$$;
-- Calls one function with real ids of (lane L, person W) but lane argument p_lane_arg and person argument p_uid_arg.
-- Returns '<outcome>' with ids and lane names masked, plus '|writes=N'.
create function pg_temp.call(p_oid oid, p_lane_arg text, p_ids_lane text, p_ids_who text, p_uid_arg uuid) returns text language plpgsql as $$
declare v_names text[]; v_types oid[]; v_name text; v_args text; v_sql text; v_out text; v_w0 bigint; m idmap%rowtype;
begin
  select * into m from idmap where lane = p_ids_lane and who = p_ids_who;
  select p.proargnames, string_to_array(p.proargtypes::text, ' ')::oid[], n.nspname || '.' || p.proname into v_names, v_types, v_name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = p_oid;
  select string_agg(case
      when v_names[i] in ('p_lane', 'p_lane_id') then quote_literal(p_lane_arg)
      when v_names[i] in ('p_uid', 'p_owner') then quote_literal(p_uid_arg) || '::uuid'
      when v_names[i] in ('p_connection') then quote_literal(case when v_name like '%teams%' then m.tconn else m.conn end) || '::uuid'
      when v_names[i] = 'p_connections' then 'array[' || quote_literal(m.tconn) || '::uuid, ' || quote_literal(m.conn) || '::uuid]'
      when v_names[i] in ('p_action') then quote_literal(m.act) || '::uuid'
      when v_names[i] = 'p_id' then quote_literal(case when v_name like '%news%' then m.news when v_name like '%briefing%' then m.run else m.act end) || '::uuid'
      when v_names[i] = 'p_claim' then quote_literal(m.run) || '::uuid'
      when v_names[i] = 'p_import_id' then quote_literal(m.imp) || '::uuid'
      when v_names[i] = 'p_path' then quote_literal(coalesce(m.doc_path, 'x'))
      when v_names[i] in ('p_thread_id') then quote_literal(coalesce(m.thread, 'x'))
      when v_names[i] in ('p_message_id') then quote_literal(coalesce(m.msg, 'x'))
      when v_names[i] = 'p_chat' then quote_literal('19:seed@thread.v2')
      when format_type(v_types[i], null) = 'uuid' then quote_literal(m.act) || '::uuid'
      when format_type(v_types[i], null) = 'text' then case when v_names[i] = 'p_view' then '''finance''' when v_names[i] = 'p_filter' then '''all''' when v_names[i] = 'p_category' then '''email''' else '''x''' end
      when format_type(v_types[i], null) in ('integer', 'numeric') then '1'
      when format_type(v_types[i], null) = 'boolean' then 'false'
      when format_type(v_types[i], null) = 'jsonb' then '''{}''::jsonb'
      when format_type(v_types[i], null) = 'date' then '''2026-11-01''::date'
      when format_type(v_types[i], null) = 'timestamp with time zone' then '''2026-11-01T00:00:00Z''::timestamptz'
      when format_type(v_types[i], null) = 'text[]' then '''{}''::text[]'
      when format_type(v_types[i], null) = 'uuid[]' then '''{}''::uuid[]'
      else 'null' end, ', ' order by i) into v_args from generate_subscripts(v_types, 1) i;
  v_sql := format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)::text from (select * from %s(%s)) t', v_name, coalesce(v_args, ''));
  v_w0 := pg_temp.writes();
  begin
    execute v_sql into v_out;
  exception when others then
    v_out := 'err:' || sqlstate || ':' || sqlerrm;
  end;
  v_out := regexp_replace(v_out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', 'g');
  v_out := replace(replace(replace(v_out, 'ZZ', '<L>'), 'APK', '<L>'), 'PKG', '<L>');
  return v_out || '|writes=' || (pg_temp.writes() - v_w0)::text;
end $$;

-- All ids of one (lane, person) as text, to look for them in an answer.
create function pg_temp.leaks(p_text text, p_lane text) returns boolean language sql as $$
  select exists (select 1 from idmap i, unnest(array[i.conn, i.tconn, i.act, i.imp, i.run]) x where i.lane = p_lane and p_text like '%' || x::text || '%')
      or exists (select 1 from idmap i where i.lane = p_lane and i.doc_path is not null and p_text like '%' || i.doc_path || '%')
      or exists (select 1 from idmap i where i.lane = p_lane and i.msg is not null and p_text like '%' || i.msg || '%');
$$;

-- Cross-lane probe: persona calls lane APK with APK ids. Violations as labels.
create function pg_temp.lane_probe(p_email text, p_aal text, p_lane text, p_ids_lane text, p_ids_who text) returns text[] language plpgsql as $$
declare v text[] := '{}'; f record; a text; z text; u uuid := (select uid from idmap where lane = p_ids_lane and who = p_ids_who);
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  for f in select * from fn where has_lane order by name loop
    a := pg_temp.call(f.oid, p_lane, p_ids_lane, p_ids_who, u);
    z := pg_temp.call(f.oid, 'ZZ', p_ids_lane, p_ids_who, u);
    if a is distinct from z then v := v || (f.name || ': ' || left(a, 70) || ' <> ' || left(z, 70)); end if;
    if pg_temp.leaks(a, p_ids_lane) then v := v || (f.name || ': answer carries a row id'); end if;
  end loop;
  reset role;
  return v;
end $$;
-- Cross-user probe: a persona calls its own lane with another person's ids.
create function pg_temp.user_ids_probe(p_email text, p_lane text, p_other_who text) returns text[] language plpgsql as $$
declare v text[] := '{}'; f record; a text; z text; u uuid := (select uid from idmap where lane = p_lane and who = p_other_who);
begin
  perform pg_temp.claims(p_email, 'aal2');
  set local role authenticated;
  for f in select * from fn where has_lane order by name loop
    a := pg_temp.call(f.oid, p_lane, p_lane, p_other_who, u);
    z := pg_temp.call(f.oid, p_lane, p_lane, 'none', '00000000-0000-4000-8000-0000000000dd'::uuid);
    if f.name not in (select name from self_writer) and a is distinct from z then v := v || (f.name || ' answers differently for a real id of another person than for a missing id: ' || left(a, 60) || ' <> ' || left(z, 60)); end if;
    if a not like '%|writes=0' and f.name not in (select name from self_writer) then v := v || (f.name || ' wrote: ' || right(a, 60)); end if;
    if pg_temp.leaks(a, p_lane) then v := v || (f.name || ' returned the other person''s row id: ' || left(a, 80)); end if;
  end loop;
  reset role;
  return v;
end $$;
-- Asking ABOUT another person.
create function pg_temp.about_probe(p_email text, p_aal text, p_about_who text) returns text[] language plpgsql as $$
declare v text[] := '{}'; f record; a text; z text; u uuid := (select uid from idmap where lane = 'PKG' and who = p_about_who);
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  for f in select * from fn where has_user order by name loop
    a := pg_temp.call(f.oid, 'PKG', 'PKG', p_about_who, u);
    z := pg_temp.call(f.oid, 'PKG', 'PKG', p_about_who, '00000000-0000-4000-8000-0000000000dd'::uuid);
    if a is distinct from z then v := v || (f.name || ': ' || left(a, 70) || ' <> ' || left(z, 70)); end if;
  end loop;
  reset role;
  return v;
end $$;

-- ---------------------------------------------------------------- the catalog is classified
select is((select count(*)::int from fn), 92, 'the catalog holds 92 functions callable by authenticated (a new one changes the count: it is probed automatically; update the figure on purpose)');
select is((select coalesce(array_agg(name order by name), '{}') from fn where not has_lane and not has_user and sig not in (select sig from no_subject_ok)), '{}'::text[],
  'every callable function takes a lane or a user, or is on the reviewed list of pure helpers');
select is((select coalesce(array_agg(sig order by sig), '{}') from no_subject_ok where sig not in (select sig from fn)), '{}'::text[], 'no stale entry on the reviewed helper list');
select is((select count(*)::int from idmap where conn is null or tconn is null or act is null or imp is null or run is null or news is null or doc_path is null or thread is null), 0, 'the seed gave every (lane, person) real ids of every kind');
select is((select count(*)::int from fn where has_lane) || ' lane functions, ' || (select count(*)::int from fn where has_user) || ' user functions', '74 lane functions, 9 user functions',
  'functions exercised: 74 take a lane (all probed cross-lane, AAL1 and cross-user) and 9 take a person (the person probe runs for all 9); 16 are reviewed pure helpers');

-- ---------------------------------------------------------------- lane parameter
select is(pg_temp.lane_probe('owner@example.test', 'aal2', 'APK', 'APK', 'admin'), '{}'::text[], 'CROSS-LANE: PKG-only owner at AAL2 asking for APK with real APK ids: the answer equals the missing-lane answer for every lane function, carries no APK id, changes no row');
select is(pg_temp.lane_probe('admin-technical@example.test', 'aal2', 'APK', 'APK', 'owner'), '{}'::text[], 'CROSS-LANE: PKG-only admin_technical, same check');
select is(pg_temp.lane_probe('finance-operator@example.test', 'aal2', 'APK', 'APK', 'owner'), '{}'::text[], 'CROSS-LANE: PKG-only finance_operator, same check');
select is(pg_temp.lane_probe('owner@example.test', 'aal1', 'PKG', 'PKG', 'owner'), '{}'::text[], 'AAL1: the PKG owner without the second factor, own lane and own ids: the missing-lane answer, no PKG id, no row changed');
select is(pg_temp.user_ids_probe('admin-technical@example.test', 'PKG', 'owner'), '{}'::text[], 'CROSS-USER: admin_technical calling lane PKG with the OWNER''s real ids gets none of the owner''s row ids, changes no row, and gets the answer given for ids that do not exist');
select is(pg_temp.user_ids_probe('owner@example.test', 'PKG', 'admin'), '{}'::text[], 'CROSS-USER: the owner calling lane PKG with the ADMIN''s real ids gets none of the admin''s row ids, changes no row, and gets the answer given for ids that do not exist');

-- ---------------------------------------------------------------- user parameter
select is(pg_temp.about_probe('admin-technical@example.test', 'aal2', 'owner'), '{}'::text[], 'CROSS-USER: asking a user-parameter function about the owner (as admin_technical) gives the answer for an unknown person');
select is(pg_temp.about_probe('owner@example.test', 'aal1', 'owner'), '{}'::text[], 'AAL1: asking about oneself without the second factor gives the answer for an unknown person');

-- ---------------------------------------------------------------- non-vacuity: the legitimate owner reaches data
create function pg_temp.reach() returns int language plpgsql as $$
declare n int := 0; f record; u uuid := (select uid from idmap where lane = 'PKG' and who = 'owner');
begin
  perform pg_temp.claims('owner@example.test', 'aal2');
  set local role authenticated;
  for f in select * from fn where has_lane order by name loop
    if pg_temp.call(f.oid, 'PKG', 'PKG', 'owner', u) is distinct from pg_temp.call(f.oid, 'ZZ', 'PKG', 'owner', u) then n := n + 1; end if;
  end loop;
  reset role;
  return n;
end $$;
select cmp_ok(pg_temp.reach(), '>=', 25, 'non-vacuity: at least 25 lane functions answer the legitimate owner differently from a missing lane (the probes reach real data)');
select * from finish();
rollback;
