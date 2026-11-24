-- T-170 (security suite), area 6: the approval gates, as a matrix over EVERY action type the database allows (the types are read from
-- act.is_allowed_type, so a new type is in the matrix at once, and fails if it has no builder below). Each cell uses a fresh proposal:
--   happy path | wrong hash | no step-up | AAL1 | approvals_live off | policy class removed | connection disconnected | expired |
--   wrong person | other lane (member / non-member) | replay of approve | replay of claim | claim before approval |
--   payload or hash tampered after approval | live off / class removed / connection disconnected / approver demoted AFTER approval (claim re-checks).
-- Real database, real roles and JWT claims; only the provider call is absent (the executors are tested per package with fakes).
begin;
select plan(27);
\ir helpers/lane_rls.psql

create function pg_temp.claims_amr(p_email text, p_aal text, p_at bigint) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal,
                      'amr', case when p_at is null then '[]'::json else json_build_array(json_build_object('method', 'totp', 'timestamp', p_at)) end)::text, true);
$$;
create function pg_temp.now_s(p_ago integer default 0) returns bigint language sql as $$ select (extract(epoch from now()) - p_ago)::bigint; $$;
create function pg_temp.cfg(p_lane text, p_key text, p_val jsonb) returns void language sql as $$
  insert into core.lane_config (lane_id, version, config)
  select lane_id, version + 1, jsonb_set(config, array[p_key], coalesce(config -> p_key, '{}'::jsonb) || p_val)
  from core.lane_config where lane_id = p_lane order by version desc limit 1;
$$;
create temp table seqn (n integer not null);
insert into seqn values (0);
grant all on seqn to public;
create function pg_temp.next_n() returns integer language sql as $$ update seqn set n = n + 1 returning n; $$;
create function pg_temp.hash(p_n integer) returns text language sql as $$ select encode(sha256(convert_to('matrix-' || p_n::text, 'utf8')), 'hex'); $$;
create function pg_temp.rid(p_n integer) returns text language sql as $$ select '5e11d0c0-0000-4000-8000-' || lpad(p_n::text, 12, '0'); $$;

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id in ('PKG', 'APK');
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": true}');
select pg_temp.cfg('PKG', 'teams', '{"enabled": true, "features": ["chat_read", "chat_send", "channels_read", "channels_send"]}');
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033801', 'PKG', 'google', 'mx-owner@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033803', 'PKG', 'microsoft_teams', 'mx-owner@teams.example.test', 'active', '{"teams_chat_send": true, "teams_channels_send": true}', pg_temp.uid('owner@example.test'));

-- Builders: one per family of types. A type without a builder raises, and the "every type has a builder" assertion fails.
create function pg_temp.family(p_type text) returns text language sql immutable as $$
  select case when p_type like 'email.%' then 'email' when p_type = 'qbo.disconnect' then 'qbo' when p_type like 'teams.%' then 'teams' end;
$$;
create function pg_temp.build(p_type text) returns uuid language plpgsql as $$
declare n integer := pg_temp.next_n(); v_conn uuid; v_target jsonb; v_payload jsonb; v_id uuid; v_ext text;
begin
  case pg_temp.family(p_type)
    when 'email' then
      v_conn := '00000000-0000-4000-8000-000000033801'; v_ext := 'mx-owner@g.example.test';
      v_target := jsonb_build_object('mailbox', v_ext); v_payload := jsonb_build_object('fromMailbox', v_ext);
    when 'teams' then
      v_conn := '00000000-0000-4000-8000-000000033803';
      v_payload := jsonb_build_object('content_type', 'text', 'text', 'Synthetic matrix message');
      v_target := case p_type
        when 'teams.chat.send' then jsonb_build_object('chat_id', '19:matrix@thread.v2', 'client_request_id', pg_temp.rid(n))
        when 'teams.channel.post' then jsonb_build_object('team_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'channel_id', '19:matrix@thread.tacv2', 'client_request_id', pg_temp.rid(n))
        when 'teams.channel.reply' then jsonb_build_object('team_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'channel_id', '19:matrix@thread.tacv2', 'reply_to_id', '1700000000000', 'client_request_id', pg_temp.rid(n))
      end;
    when 'qbo' then
      v_conn := ('00000000-0000-4000-8000-000338' || lpad(n::text, 6, '0'))::uuid;
      v_ext := 'realm-matrix-' || n::text;
      insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values (v_conn, 'PKG', 'quickbooks', v_ext, 'active', '{}', null);
      v_target := jsonb_build_object('realm_id', v_ext); v_payload := '{}'::jsonb;
    else raise exception 'no builder for action type %', p_type;
  end case;
  set local role service_role;
  v_id := act.propose('PKG', p_type, v_conn, v_target, v_payload, 1, pg_temp.hash(n), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
  reset role;
  return v_id;
end $$;

-- Runs a statement as a role/persona and returns 'ok' or '<sqlstate> <message>'.
create function pg_temp.as_user(p_email text, p_aal text, p_age integer, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.claims_amr(p_email, p_aal, case when p_age is null then null else pg_temp.now_s(p_age) end);
  set local role authenticated;
  begin
    execute p_sql into v;
    reset role;
    return 'ok';
  exception when others then
    reset role;
    return sqlstate || ' ' || sqlerrm;
  end;
end $$;
create function pg_temp.as_service(p_sql text) returns text language plpgsql as $$
begin
  set local role service_role;
  begin
    execute p_sql;
    reset role;
    return 'ok';
  exception when others then
    reset role;
    return sqlstate || ' ' || sqlerrm;
  end;
end $$;
create function pg_temp.approve(p_id uuid, p_lane text default 'PKG', p_hash text default null, p_email text default 'owner@example.test', p_aal text default 'aal2', p_age integer default 10) returns text language plpgsql as $$
begin
  return pg_temp.as_user(p_email, p_aal, p_age, format('select core.act_approve(%L, %L, %L)', p_lane, p_id, coalesce(p_hash, (select payload_sha256 from act.proposed_actions where id = p_id))));
end $$;
create function pg_temp.claim(p_id uuid) returns text language sql as $$ select pg_temp.as_service(format('select core.act_claim_execution(%L, %L)', 'PKG', p_id)); $$;
create function pg_temp.claim_in(p_lane text, p_id uuid) returns text language sql as $$ select pg_temp.as_service(format('select core.act_claim_execution(%L, %L)', p_lane, p_id)); $$;
-- one approve attempt with the TOTP code p_age seconds old, on a fresh proposal of the type
create function pg_temp.attempt(p_type text, p_age integer) returns text language plpgsql as $$
declare v_id uuid := pg_temp.build(p_type);
begin
  return case when pg_temp.approve(v_id, 'PKG', null, 'owner@example.test', 'aal2', p_age) = 'ok' then 'ok' else 'refused' end;
end $$;
create function pg_temp.live(p_on boolean) returns void language sql as $$ select pg_temp.cfg('PKG', 'approvals', jsonb_build_object('approvals_live', p_on)); $$;
create function pg_temp.classes(p_all boolean) returns void language sql as $$
  update core.lane_policies set write_actions_allowed = case when p_all then array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] else '{}'::text[] end where lane_id = 'PKG';
$$;
create function pg_temp.conn_of(p_id uuid) returns uuid language sql as $$ select connection_id from act.proposed_actions where id = p_id; $$;
create function pg_temp.status_of(p_id uuid) returns text language sql as $$ select status from act.proposed_actions where id = p_id; $$;
create function pg_temp.wrong_person(p_type text) returns text language sql as $$ select case when pg_temp.family(p_type) = 'qbo' then 'finance-operator@example.test' else 'admin-technical@example.test' end; $$;

-- One cell. Every scenario ends with the world restored (live on, all classes, connections active, owner role owner).
create function pg_temp.cell(p_type text, p_scn text) returns text language plpgsql as $$
declare aid uuid := pg_temp.build(p_type); r text; r2 text; cn uuid;
begin
  cn := pg_temp.conn_of(aid);
  case p_scn
    when 'happy' then r := pg_temp.approve(aid); r2 := pg_temp.claim(aid); return r || '+' || r2 || '+' || pg_temp.status_of(aid);
    when 'bad_hash' then return pg_temp.approve(aid, 'PKG', repeat('0', 64)) || '|' || pg_temp.status_of(aid);
    when 'no_step_up' then return pg_temp.approve(aid, 'PKG', null, 'owner@example.test', 'aal2', 100000) || '|' || pg_temp.approve(aid, 'PKG', null, 'owner@example.test', 'aal2', null);
    when 'aal1' then return pg_temp.approve(aid, 'PKG', null, 'owner@example.test', 'aal1', 10) || '|' || pg_temp.status_of(aid);
    when 'live_off' then perform pg_temp.live(false); r := pg_temp.approve(aid); perform pg_temp.live(true); return r || '|' || pg_temp.status_of(aid);
    when 'class_removed' then perform pg_temp.classes(false); r := pg_temp.approve(aid); perform pg_temp.classes(true); return r || '|' || pg_temp.status_of(aid);
    when 'conn_disconnected' then update core.connections set status = 'disconnected' where core.connections.id = cn; r := pg_temp.approve(aid); update core.connections set status = 'active' where core.connections.id = cn; return r || '|' || pg_temp.status_of(aid);
    when 'expired' then
      alter table act.proposed_actions disable trigger proposed_actions_guard; -- test-only, as in 290: age the action
      update act.proposed_actions set expires_at = now() - interval '1 minute' where act.proposed_actions.id = aid;
      alter table act.proposed_actions enable trigger proposed_actions_guard;
      return pg_temp.approve(aid);
    when 'wrong_person' then return pg_temp.approve(aid, 'PKG', null, pg_temp.wrong_person(p_type)) || '|' || pg_temp.status_of(aid);
    when 'other_lane_member' then return pg_temp.approve(aid, 'APK') || '|' || pg_temp.status_of(aid);
    when 'other_lane_nonmember' then return pg_temp.approve(aid, 'APK', null, 'admin-technical@example.test') || '|' || pg_temp.status_of(aid);
    when 'replay_approve' then r := pg_temp.approve(aid); return r || '+' || pg_temp.approve(aid);
    when 'replay_claim' then r := pg_temp.approve(aid); r2 := pg_temp.claim(aid); return r2 || '+' || pg_temp.claim(aid);
    when 'claim_unapproved' then return pg_temp.claim(aid) || '|' || pg_temp.status_of(aid);
    when 'tamper_after_approval' then
      r := pg_temp.approve(aid);
      begin update act.proposed_actions set payload = payload || '{"x":"tampered"}' where act.proposed_actions.id = aid; r2 := 'changed'; exception when others then r2 := sqlstate; end;
      begin update act.proposed_actions set payload_sha256 = repeat('e', 64) where act.proposed_actions.id = aid; r2 := r2 || '+changed'; exception when others then r2 := r2 || '+' || sqlstate; end;
      begin update act.proposed_actions set approved_hash = repeat('f', 64) where act.proposed_actions.id = aid; r2 := r2 || '+changed'; exception when others then r2 := r2 || '+' || sqlstate; end;
      begin update act.proposed_actions set target = '{"mailbox":"evil@example.test"}' where act.proposed_actions.id = aid; r2 := r2 || '+changed'; exception when others then r2 := r2 || '+' || sqlstate; end;
      return r2 || '|' || pg_temp.claim(aid);
    when 'claim_live_off' then r := pg_temp.approve(aid); perform pg_temp.live(false); r2 := pg_temp.claim(aid); perform pg_temp.live(true); return r2 || '|' || pg_temp.status_of(aid);
    when 'claim_class_removed' then r := pg_temp.approve(aid); perform pg_temp.classes(false); r2 := pg_temp.claim(aid); perform pg_temp.classes(true); return r2 || '|' || pg_temp.status_of(aid);
    when 'claim_conn_disconnected' then r := pg_temp.approve(aid); update core.connections set status = 'disconnected' where core.connections.id = cn; r2 := pg_temp.claim(aid); update core.connections set status = 'active' where core.connections.id = cn; return r2 || '|' || pg_temp.status_of(aid);
    when 'claim_approver_demoted' then
      r := pg_temp.approve(aid);
      update core.memberships set role = 'viewer' where lane_id = 'PKG' and user_id = pg_temp.uid('owner@example.test');
      r2 := pg_temp.claim(aid);
      update core.memberships set role = 'owner' where lane_id = 'PKG' and user_id = pg_temp.uid('owner@example.test');
      return r2 || '|' || pg_temp.status_of(aid);
    when 'claim_expired' then
      r := pg_temp.approve(aid);
      alter table act.proposed_actions disable trigger proposed_actions_guard; -- test-only: age the approved action
      update act.proposed_actions set expires_at = now() - interval '1 minute' where act.proposed_actions.id = aid;
      alter table act.proposed_actions enable trigger proposed_actions_guard;
      r2 := pg_temp.claim(aid);
      return r || '|' || r2 || '|' || pg_temp.status_of(aid);
    when 'claim_other_lane' then r := pg_temp.approve(aid); r2 := pg_temp.claim_in('APK', aid); return r || '|' || r2 || '|' || pg_temp.status_of(aid) || '|' || pg_temp.claim(aid);
    when 'claim_hash_recheck' then
      r := pg_temp.approve(aid);
      alter table act.proposed_actions disable trigger proposed_actions_guard; -- second layer: even if the trigger were bypassed, the claim re-checks the hash
      update act.proposed_actions set payload_sha256 = repeat('c', 64) where act.proposed_actions.id = aid;
      alter table act.proposed_actions enable trigger proposed_actions_guard;
      r2 := pg_temp.claim(aid);
      return r || '|' || r2 || '|' || pg_temp.status_of(aid);
    -- step-up window bounds: Teams has its own setting (300 default and floor, 43,200 cap); email and QuickBooks use step_up_max_age_s (300 default, 30 floor, 900 cap)
    when 'window_teams' then
      if pg_temp.family(p_type) <> 'teams' then return 'n/a'; end if;
      r := pg_temp.attempt(p_type, 200) || ',' || pg_temp.attempt(p_type, 400);
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "3600"}'); r := r || '|' || pg_temp.attempt(p_type, 3000) || ',' || pg_temp.attempt(p_type, 3700);
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "99999"}'); r := r || '|' || pg_temp.attempt(p_type, 43000) || ',' || pg_temp.attempt(p_type, 44000);
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "10"}'); r := r || '|' || pg_temp.attempt(p_type, 200) || ',' || pg_temp.attempt(p_type, 400);
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "abc"}'); r := r || '|' || pg_temp.attempt(p_type, 200) || ',' || pg_temp.attempt(p_type, 400);
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "300"}');
      return r;
    when 'window_email' then
      if pg_temp.family(p_type) = 'teams' then return 'n/a'; end if;
      r := pg_temp.attempt(p_type, 200) || ',' || pg_temp.attempt(p_type, 400);
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "43200"}'); r := r || '|' || pg_temp.attempt(p_type, 400); -- the Teams window does not widen email or QuickBooks
      perform pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": "300"}');
      perform pg_temp.cfg('PKG', 'approvals', '{"step_up_max_age_s": "9999"}'); r := r || '|' || pg_temp.attempt(p_type, 800) || ',' || pg_temp.attempt(p_type, 1000);
      perform pg_temp.cfg('PKG', 'approvals', '{"step_up_max_age_s": "5"}'); r := r || '|' || pg_temp.attempt(p_type, 20) || ',' || pg_temp.attempt(p_type, 100);
      perform pg_temp.cfg('PKG', 'approvals', '{"step_up_max_age_s": "300"}');
      return r;
    else raise exception 'unknown scenario %', p_scn;
  end case;
end $$;

-- Types as the database defines them: act.is_allowed_type is CALLED over every `<prefix>.<verb>` a pattern could admit (see 334), so a type added by a
-- list, a `like` pattern or a regex enters the matrix and fails below until it has a builder.
create temp table db_types on commit drop as
select t from (select p || '.' || v as t from unnest(array['email','qbo','teams','calendar','monday','notion','google','microsoft','quickbooks','stripe','gohighlevel','payment','transfer','file','doc','slack','task','project','contact','memory','brain','lane','user','approval','audit','secret','teams_send','email_send','email_draft','qbo_disconnect']) p
  cross join unnest(array['send','save_draft','create','update','delete','post','reply','set_status','disconnect','revoke_grant','chat.send','channel.post','channel.reply','item.create','item.update','item.set_status','event.create','event.update','page.update','page.create','edit','forward','archive','draft','approve','execute','read','write','move','share','invite','remove','grant']) v) c
where act.is_allowed_type(t);
grant all on db_types to public;
-- expected[scenario, family] -> outcome; '*' means every family
create temp table expected (scn text, fam text, outcome text, primary key (scn, fam));
insert into expected values
  ('happy', '*', 'ok+ok+executing'),
  ('bad_hash', '*', '22000 act: hash_mismatch|proposed'),
  ('no_step_up', '*', '42501 act: step_up_required|42501 act: step_up_required'),
  ('aal1', '*', '42501 act: a signed-in session at aal2 is required|proposed'),
  ('live_off', '*', '22000 act: not_live|proposed'),
  ('class_removed', '*', '22000 act: type_not_allowed|proposed'),
  ('conn_disconnected', '*', '22000 act: connection_not_enabled|proposed'),
  ('expired', '*', '22000 act: expired'),
  ('wrong_person', 'email', '42704 act: not_found|proposed'),
  ('wrong_person', 'teams', '42704 act: not_found|proposed'),
  ('wrong_person', 'qbo', '42501 act: the owner role in this lane is required|proposed'),
  ('other_lane_member', '*', '42704 act: not_found|proposed'),
  ('other_lane_nonmember', '*', '42501 act: the owner role in this lane is required|proposed'),
  ('replay_approve', '*', 'ok+22000 act: already_approved'),
  ('replay_claim', '*', 'ok+22000 act: not_approved'),
  ('claim_unapproved', '*', '22000 act: not_approved|proposed'),
  ('tamper_after_approval', '*', '42501+42501+42501+42501|ok'),
  ('claim_live_off', '*', '22000 act: not_live|approved'),
  ('claim_class_removed', '*', '22000 act: type_not_allowed|approved'),
  ('claim_conn_disconnected', '*', '22000 act: connection_not_enabled|approved'),
  ('claim_approver_demoted', '*', '22000 act: approver_revoked|approved'),
  ('claim_expired', '*', 'ok|22000 act: expired|approved'),
  ('claim_other_lane', '*', 'ok|42704 act: not_found|approved|ok'),
  ('claim_hash_recheck', '*', 'ok|22000 act: hash_mismatch|approved'),
  ('window_teams', 'teams', 'ok,refused|ok,refused|ok,refused|ok,refused|ok,refused'),
  ('window_teams', 'email', 'n/a'), ('window_teams', 'qbo', 'n/a'),
  ('window_email', 'teams', 'n/a'),
  ('window_email', 'email', 'ok,refused|refused|ok,refused|ok,refused'),
  ('window_email', 'qbo', 'ok,refused|refused|ok,refused|ok,refused');
grant all on expected to public;

select is((select coalesce(array_agg(t order by t), '{}') from db_types where pg_temp.family(t) is null), '{}'::text[], 'every allowed action type belongs to a family with a builder (a new type must be added to this matrix first)');
select is((select count(*)::int from db_types), 6, 'six allowed types are in the matrix (email.send, email.save_draft, qbo.disconnect, teams.chat.send, teams.channel.post, teams.channel.reply)');

-- SQLSTATE of "raise exception ... using errcode = 'P0001'" prints as P0001; normalise the codes the matrix writes down above.
create function pg_temp.norm(p text) returns text language sql immutable as $$
  select replace(replace(replace(p, 'P0001', '22000'), 'P0002', '42704'), '42704 act: not_found', '42704 act: not_found');
$$;

create function pg_temp.scenario_violations(p_scn text) returns text[] language plpgsql as $$
declare v text[] := '{}'; t record; got text; want text;
begin
  for t in select d.t from db_types d order by d.t loop
    got := pg_temp.norm(pg_temp.cell(t.t, p_scn));
    -- keep the lane's pending cap (20) free: withdraw whatever this cell left proposed
    perform pg_temp.as_user('owner@example.test', 'aal2', 10, format('select core.act_reject(%L, %L, %L)', 'PKG', x.id, 'matrix cleanup')) from act.proposed_actions x where x.lane_id = 'PKG' and x.status = 'proposed';
    select outcome into want from expected e where e.scn = p_scn and e.fam in (pg_temp.family(t.t), '*') order by (e.fam = '*') limit 1;
    if want is null then v := v || (t.t || ': no expectation'); continue; end if;
    -- the expired / not-found messages are matched by prefix (the message may carry the status after '|')
    if got is distinct from want then v := v || (t.t || ': got [' || coalesce(got, 'null') || '] want [' || want || ']'); end if;
  end loop;
  return v;
end $$;

select is(pg_temp.scenario_violations('happy'), '{}'::text[], 'MATRIX happy path: approve the exact hash with a fresh step-up, claim once, status executing (every type)');
select is(pg_temp.scenario_violations('bad_hash'), '{}'::text[], 'MATRIX hash the approver did not see: refused, still proposed (every type)');
select is(pg_temp.scenario_violations('no_step_up'), '{}'::text[], 'MATRIX no recent TOTP (old, or none at all): refused with step_up_required (every type)');
select is(pg_temp.scenario_violations('aal1'), '{}'::text[], 'MATRIX AAL1 session: refused (every type)');
select is(pg_temp.scenario_violations('live_off'), '{}'::text[], 'MATRIX approvals_live off: approve refused (every type)');
select is(pg_temp.scenario_violations('class_removed'), '{}'::text[], 'MATRIX policy class removed: approve refused (every type)');
select is(pg_temp.scenario_violations('conn_disconnected'), '{}'::text[], 'MATRIX connection disconnected: approve refused (every type)');
select is(pg_temp.scenario_violations('expired'), '{}'::text[], 'MATRIX expired proposal: approve refused (every type)');
select is(pg_temp.scenario_violations('wrong_person'), '{}'::text[], 'MATRIX another person (admin for a mailbox or Teams action of the owner; finance_operator for a QuickBooks disconnect): refused, still proposed');
select is(pg_temp.scenario_violations('other_lane_member'), '{}'::text[], 'MATRIX CROSS-LANE: a member of both lanes approving a PKG action through lane APK finds nothing (not_found)');
select is(pg_temp.scenario_violations('other_lane_nonmember'), '{}'::text[], 'MATRIX CROSS-LANE: a PKG-only member approving through lane APK is refused');
select is(pg_temp.scenario_violations('replay_approve'), '{}'::text[], 'MATRIX replay: a second approve is refused (every type)');
select is(pg_temp.scenario_violations('replay_claim'), '{}'::text[], 'MATRIX double execute: a second claim is refused, so a second write can never start (every type)');
select is(pg_temp.scenario_violations('claim_unapproved'), '{}'::text[], 'MATRIX an unapproved action cannot be claimed (every type)');
select is(pg_temp.scenario_violations('tamper_after_approval'), '{}'::text[], 'MATRIX payload, hash, approved hash and target are immutable after approval; the claim still works on the approved content (every type)');
select is(pg_temp.scenario_violations('claim_live_off'), '{}'::text[], 'MATRIX the claim re-checks approvals_live (every type)');
select is(pg_temp.scenario_violations('claim_class_removed'), '{}'::text[], 'MATRIX the claim re-checks the policy class (every type)');
select is(pg_temp.scenario_violations('claim_conn_disconnected'), '{}'::text[], 'MATRIX the claim re-checks the connection (every type)');
select is(pg_temp.scenario_violations('claim_approver_demoted'), '{}'::text[], 'MATRIX the claim refuses when the approver no longer holds the role (every type)');
select is(pg_temp.scenario_violations('claim_expired'), '{}'::text[], 'MATRIX the claim refuses an action that expired after approval (every type)');
select is(pg_temp.scenario_violations('claim_other_lane'), '{}'::text[], 'MATRIX a claim through another lane finds nothing (not_found) and the real claim still works (every type)');
select is(pg_temp.scenario_violations('claim_hash_recheck'), '{}'::text[], 'MATRIX if the stored hash were changed behind the trigger, the claim re-checks it and refuses (hash_mismatch) (every type)');
select is(pg_temp.scenario_violations('window_teams'), '{}'::text[], 'MATRIX Teams step-up window: default 300 s, set 3,600, capped at 43,200, floor 300, nonsense falls back to 300 (Teams types)');
select is(pg_temp.scenario_violations('window_email'), '{}'::text[], 'MATRIX email and QuickBooks step-up window: default 300 s, the Teams window does not widen it, capped at 900, floor 30 (email and qbo types)');
select is((select coalesce(array_agg(scn), '{}') from (select distinct scn from expected) x where scn not in ('claim_expired','claim_other_lane','claim_hash_recheck','window_teams','window_email','happy','bad_hash','no_step_up','aal1','live_off','class_removed','conn_disconnected','expired','wrong_person','other_lane_member','other_lane_nonmember','replay_approve','replay_claim','claim_unapproved','tamper_after_approval','claim_live_off','claim_class_removed','claim_conn_disconnected','claim_approver_demoted')), '{}'::text[], 'every expectation has a scenario run above');

select * from finish();
rollback;
