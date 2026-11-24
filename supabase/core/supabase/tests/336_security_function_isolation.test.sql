-- T-170 (security suite), area 1 (functions): every function `authenticated` can execute in an app schema is enumerated from pg_proc and
-- called as a persona that must NOT get the data.
--   * functions with a lane parameter (p_lane): a PKG-only user asking for another lane (APK), and an AAL1 user asking for PKG, must get an
--     error or EXACTLY the answer given for a lane that does not exist (no data and no existence oracle);
--   * functions with a user parameter (p_uid, p_owner): asking about another person must give an error or exactly the answer for a person
--     that does not exist (no membership, mailbox or role enumeration);
--   * functions with neither are on a reviewed list with a reason (pure helpers); a new one fails until classified; a stale entry fails;
--   * owner-only reads (inbox, Teams read markers, approvals) are proven with real rows: the owner sees them, the same-lane admin does not.
begin;
select plan(12);
\ir helpers/lane_rls.psql

update core.lanes set enabled = true where code = 'APK';
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test');
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft'], store_outbound_drafts = true where lane_id = 'PKG';
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033601', 'PKG', 'google', 'fn-owner@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033602', 'PKG', 'microsoft_teams', 'fn-owner@teams.example.test', 'active', '{}', pg_temp.uid('owner@example.test'));
insert into comms.message_index (lane_id, connection_id, provider, message_id, thread_id, from_address, subject, received_at, is_read, is_important, folder, labels, deleted, source_updated_at)
values ('PKG', '00000000-0000-4000-8000-000000033601', 'google', 'fn-m-1', 'fn-t-1', 'sender@example.test', 'Synthetic subject', now(), false, true, 'INBOX', '{}', false, now());
insert into comms.teams_chat_reads (lane_id, connection_id, chat_id, read_through) values ('PKG', '00000000-0000-4000-8000-000000033602', '19:fn-chat-1@thread.v2', now());
set local role service_role;
select core.act_propose('PKG', 'email.send', '00000000-0000-4000-8000-000000033601', '{"mailbox":"fn-owner@g.example.test"}'::jsonb, '{"fromMailbox":"fn-owner@g.example.test"}'::jsonb, 1, repeat('d', 64), null, '[]'::jsonb, 'assistant', pg_temp.uid('owner@example.test'), true);
reset role;

-- Reviewed functions with neither a lane nor a user parameter (pure helpers or definer-gated by an id).
create temp table no_subject_ok (sig text primary key, why text not null) on commit drop;
insert into no_subject_ok values
  ('act.is_email_type(text)', 'pure classifier of a type string'),
  ('act.is_teams_type(text)', 'pure classifier of a type string'),
  ('act.is_unknown_failure(text)', 'pure classifier of a failure code'),
  ('act.action_rows_visible(uuid)', 'RLS helper: true only for an action the caller may see (proven below with a real row)'),
  ('core.brain_home_lane()', 'returns the configured home lane code of the brain, no lane data'),
  ('core.role_views(text)', 'static role to view map'),
  ('core.view_names()', 'static list of view names'),
  ('core.viewer_view_names()', 'static list of view names'),
  ('fin.business_week(timestamp with time zone)', 'pure date helper'),
  ('fin.et_date(timestamp with time zone)', 'pure date helper'),
  ('fin.month_range(date)', 'pure date helper'),
  ('fin.month_start(date)', 'pure date helper'),
  ('fin.mtd_range(timestamp with time zone)', 'pure date helper'),
  ('fin.next_month_start(date)', 'pure date helper'),
  ('fin.ytd_range(date)', 'pure date helper'),
  ('fin.ytd_start(date)', 'pure date helper');
grant all on no_subject_ok to public;

create temp table fn on commit drop as
select p.oid::regprocedure as sig, p.oid as oid, n.nspname || '.' || p.proname as name, p.proargnames as argnames, string_to_array(p.proargtypes::text, ' ')::oid[] as argtypes,
       (p.proargnames && array['p_lane', 'p_lane_id']) as has_lane,
       (p.proargnames && array['p_uid', 'p_owner']) as has_user,
       p.prosecdef as definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('act', 'audit', 'brain', 'brief', 'cal', 'comms', 'core', 'fin', 'raw') and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute');
grant all on fn to public;

-- One call, reduced to a comparable text: 'err:<sqlstate>:<message with the lane masked>' or the JSON of the rows.
create function pg_temp.outcome(p_oid oid, p_lane text, p_uid uuid) returns text language plpgsql as $$
declare v_args text; v_sql text; v_out text; v_names text[]; v_types oid[]; v_name text;
begin
  select argnames, argtypes, nspname || '.' || proname into v_names, v_types, v_name
    from (select p.proargnames as argnames, string_to_array(p.proargtypes::text, ' ')::oid[] as argtypes, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = p_oid) q;
  select string_agg(case
      when v_names[i] in ('p_lane', 'p_lane_id') then quote_literal(p_lane)
      when v_names[i] in ('p_uid', 'p_owner') then quote_literal(p_uid) || '::uuid'
      when format_type(v_types[i], null) = 'uuid' then '''00000000-0000-4000-8000-0000000000cc''::uuid'
      when format_type(v_types[i], null) = 'text' then case when v_names[i] = 'p_view' then '''finance''' when v_names[i] = 'p_filter' then '''all''' else '''x''' end
      when format_type(v_types[i], null) = 'integer' then '1'
      when format_type(v_types[i], null) = 'numeric' then '1'
      when format_type(v_types[i], null) = 'boolean' then 'false'
      when format_type(v_types[i], null) = 'jsonb' then '''{}''::jsonb'
      when format_type(v_types[i], null) = 'date' then '''2026-11-01''::date'
      when format_type(v_types[i], null) = 'timestamp with time zone' then '''2026-11-01T00:00:00Z''::timestamptz'
      when format_type(v_types[i], null) = 'text[]' then '''{}''::text[]'
      when format_type(v_types[i], null) = 'uuid[]' then '''{}''::uuid[]'
      else 'null' end, ', ' order by i) into v_args from generate_subscripts(v_types, 1) i;
  v_sql := format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb)::text from (select * from %s(%s)) t', v_name, coalesce(v_args, ''));
  begin
    execute v_sql into v_out;
    return v_out;
  exception when others then
    return 'err:' || sqlstate || ':' || replace(sqlerrm, p_lane, '<L>');
  end;
end $$;

-- Violations of one probe: p_lane / p_uid for the real subject, p_zz_lane / p_zz_uid for "nothing there".
create function pg_temp.lane_probe(p_email text, p_aal text, p_lane text) returns text[] language plpgsql as $$
declare v text[] := '{}'; f record; a text; z text; u uuid := pg_temp.uid(p_email);
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  for f in select * from fn where has_lane order by name loop
    a := pg_temp.outcome(f.oid, p_lane, u);
    z := pg_temp.outcome(f.oid, 'ZZ', u);
    if a not like 'err:%' and a is distinct from z then v := v || (f.name || ' -> ' || left(a, 80)); end if;
  end loop;
  reset role;
  return v;
end $$;
create function pg_temp.user_probe(p_email text, p_aal text, p_other_email text) returns text[] language plpgsql as $$
declare v text[] := '{}'; f record; a text; z text; u uuid := pg_temp.uid(p_email);
begin
  perform pg_temp.claims(p_email, p_aal);
  set local role authenticated;
  for f in select * from fn where has_user order by name loop
    a := pg_temp.outcome(f.oid, 'PKG', pg_temp.uid(p_other_email));
    z := pg_temp.outcome(f.oid, 'PKG', '00000000-0000-4000-8000-0000000000dd'::uuid);
    if a not like 'err:%' and a is distinct from z then v := v || (f.name || ' -> ' || left(a, 80)); end if;
  end loop;
  reset role;
  return v;
end $$;

-- ------------------------------------------------------------------ the catalog is classified
select is((select count(*)::int from fn), 92, 'the catalog holds 92 functions callable by authenticated (a new one changes the count: it is then probed automatically; update the figure on purpose)');
select is((select coalesce(array_agg(name order by name), '{}') from fn where not has_lane and not has_user and sig::text not in (select sig from no_subject_ok)), '{}'::text[],
  'every callable function takes a lane or a user, or is on the reviewed list of pure helpers');
select is((select coalesce(array_agg(sig order by sig), '{}') from no_subject_ok where sig not in (select sig::text from fn)), '{}'::text[], 'no stale entry on the reviewed helper list');

-- ------------------------------------------------------------------ lane parameter
select is(pg_temp.lane_probe('owner@example.test', 'aal2', 'APK'), '{}'::text[], 'CROSS-LANE: a PKG-only owner at AAL2 gets an error or the same answer as for a missing lane from every lane function, for APK');
select is(pg_temp.lane_probe('admin-technical@example.test', 'aal2', 'APK'), '{}'::text[], 'CROSS-LANE: PKG-only admin_technical, same check');
select is(pg_temp.lane_probe('viewer@example.test', 'aal2', 'APK'), '{}'::text[], 'CROSS-LANE: PKG-only viewer, same check');
select is(pg_temp.lane_probe('owner@example.test', 'aal1', 'PKG'), '{}'::text[], 'AAL1: the PKG owner without the second factor gets an error or the missing-lane answer from every lane function, for PKG itself');

-- ------------------------------------------------------------------ user parameter
select is(pg_temp.user_probe('admin-technical@example.test', 'aal2', 'owner@example.test'), '{}'::text[], 'CROSS-USER: asking a function about the owner (as admin_technical) is an error or the answer for an unknown person');
select is(pg_temp.user_probe('owner@example.test', 'aal1', 'owner@example.test'), '{}'::text[], 'AAL1: asking about oneself without the second factor is an error or the answer for an unknown person');

-- ------------------------------------------------------------------ non-vacuity: the probe does see data when it should
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select cmp_ok((select count(*) from fn f where f.has_lane and pg_temp.outcome(f.oid, 'PKG', pg_temp.uid('owner@example.test')) not like 'err:%'
                 and pg_temp.outcome(f.oid, 'PKG', pg_temp.uid('owner@example.test')) is distinct from pg_temp.outcome(f.oid, 'ZZ', pg_temp.uid('owner@example.test'))), '>=', 15::bigint,
  'non-vacuity: at least 15 lane functions answer the PKG owner differently from a missing lane (the probes are not all stopped by bad arguments)');
reset role;

-- ------------------------------------------------------------------ owner-only reads with real rows
create function pg_temp.owner_only_reads(p_email text) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.claims(p_email, 'aal2');
  set local role authenticated;
  r := (select count(*) from core.inbox_messages('PKG', 'all', null, null, 10))::text
    || ':' || (select count(*) from core.teams_chat_reads_list('PKG', '00000000-0000-4000-8000-000000033602'))::text
    || ':' || (select count(*) from core.act_list('PKG', 10))::text
    || ':' || (select count(*) from comms.message_index where message_id = 'fn-m-1')::text
    || ':' || (select count(*) from act.proposed_actions where connection_id = '00000000-0000-4000-8000-000000033601')::text
    || ':' || (select count(*) from comms.teams_chat_reads where connection_id = '00000000-0000-4000-8000-000000033602')::text;
  reset role;
  return r;
end $$;
select is(pg_temp.owner_only_reads('owner@example.test'), '1:1:1:1:1:1', 'positive control: the owner reads their own message, Teams read marker and approval through the functions and the tables');
select is(pg_temp.owner_only_reads('admin-technical@example.test'), '0:0:0:0:0:0', 'CROSS-USER: admin_technical in the same lane reads none of the owner''s message, Teams read marker or approval, through functions or tables');

select * from finish();
rollback;
