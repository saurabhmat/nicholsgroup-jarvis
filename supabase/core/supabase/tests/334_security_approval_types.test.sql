-- T-170 (security suite), area 6, database side. Catalog-driven: the set of action types is READ from the definition of act.is_allowed_type and
-- the set of lane policy classes from the check constraint, so a new type or class fails here until it is classified below.
--   * every allowed type is in the reviewed list with its policy class, roles and executor family;
--   * a type outside the list, and the names a monday.com / Notion / calendar / Google-revoke action would have, cannot be proposed;
--   * the policy classes `calendar`, `monday`, `notion` (accepted by the lane policy but backed by no type or executor) enable nothing;
--   * for each type, act.type_allowed is true only for its own class: no class enables another type.
begin;
select plan(12);
\ir helpers/lane_rls.psql

create temp table reviewed_types (t text primary key, class text not null, roles text[] not null, family text not null) on commit drop;
insert into reviewed_types values
  ('email.send', 'email_send', array['owner','admin_technical'], 'email'),
  ('email.save_draft', 'email_draft', array['owner','admin_technical'], 'email'),
  ('qbo.disconnect', 'qbo_disconnect', array['owner','admin_technical'], 'quickbooks'),
  ('teams.chat.send', 'teams_send', array['owner','admin_technical'], 'teams'),
  ('teams.channel.post', 'teams_send', array['owner','admin_technical'], 'teams'),
  ('teams.channel.reply', 'teams_send', array['owner','admin_technical'], 'teams');
-- Classes the lane policy accepts that no type uses: inert by construction (finding F-03); an entry here that becomes gated fails.
create temp table inert_classes (c text primary key, why text not null) on commit drop;
insert into inert_classes values
  ('calendar', 'no calendar action type or executor'),
  ('monday', 'no monday.item.* action type or executor'),
  ('notion', 'no notion action type or executor');

-- Types as the database defines them: the function is CALLED over every `<prefix>.<verb>` a pattern could admit (prefixes: every class and its words, every
-- known provider and area; verbs: every action word), so an `in (...)` list, a `like 'calendar.%'` pattern or a regex is all found by behaviour.
create temp table cand on commit drop as
select p || '.' || v as t from unnest(array['email','qbo','teams','calendar','monday','notion','google','microsoft','quickbooks','stripe','gohighlevel','payment','transfer','file','doc','slack','task','project','contact','memory','brain','lane','user','approval','audit','secret']
  || array(select distinct unnest(string_to_array(m[1], '_')) from regexp_matches((select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_policies_write_actions_allowed_check'), '''([a-z_]+)''', 'g') m)) p
cross join unnest(array['send','save_draft','create','update','delete','post','reply','set_status','disconnect','revoke_grant','chat.send','channel.post','channel.reply','item.create','item.update','item.set_status','event.create','event.update','page.update','page.create','edit','forward','archive','draft','approve','execute','read','write','move','share','invite','remove','grant']) v;
create temp table db_types on commit drop as select t from cand where act.is_allowed_type(t);
create temp table db_classes on commit drop as
  select m[1] as c from regexp_matches(
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lane_policies_write_actions_allowed_check'), '''([a-z_]+)''', 'g') m;

select is((select coalesce(array_agg(t order by t), '{}') from db_types where t not in (select t from reviewed_types)), '{}'::text[],
  'every action type the database allows is on the reviewed list (a new type needs executor, gates and tamper tests first)');
select is((select coalesce(array_agg(t order by t), '{}') from reviewed_types where t not in (select t from db_types)), '{}'::text[],
  'no stale entry on the reviewed type list');
select is((select coalesce(array_agg(c order by c), '{}') from db_classes
           where c not in (select class from reviewed_types) and c not in (select c from inert_classes)), '{}'::text[],
  'every lane policy class is either used by a reviewed type or on the inert list');
select is((select coalesce(array_agg(c order by c), '{}') from inert_classes where c not in (select c from db_classes)
              or c in (select class from reviewed_types)), '{}'::text[],
  'no stale inert class (and none has become gated)');

-- Roles per type match the review.
select is((select coalesce(array_agg(t order by t), '{}') from reviewed_types r where act.write_roles(r.t) is distinct from r.roles), '{}'::text[],
  'act.write_roles matches the reviewed roles for every type; nobody below owner/admin_technical can write');

-- The class matrix: with exactly one class in the lane policy, only that class'' types pass act.type_allowed.
create function pg_temp.matrix_violations() returns text[] language plpgsql as $$
declare v text[] := '{}'; cr record; r record; allowed boolean;
begin
  for cr in select d.c as cls from db_classes d loop
    update core.lane_policies set write_actions_allowed = array[cr.cls] where lane_id = 'PKG';
    for r in select t, class from reviewed_types loop
      allowed := act.type_allowed('PKG', r.t);
      if allowed is distinct from (r.class = cr.cls) then v := v || (cr.cls || '/' || r.t); end if;
    end loop;
  end loop;
  update core.lane_policies set write_actions_allowed = '{}' where lane_id = 'PKG';
  for r in select t from reviewed_types loop
    if act.type_allowed('PKG', r.t) then v := v || ('empty/' || r.t); end if;
  end loop;
  update core.lane_policies set write_actions_allowed = array(select i.c from inert_classes i) where lane_id = 'PKG';
  for r in select t from reviewed_types loop
    if act.type_allowed('PKG', r.t) then v := v || ('inert/' || r.t); end if;
  end loop;
  return v;
end $$;
select is(pg_temp.matrix_violations(), '{}'::text[], 'class x type matrix: a class enables only its own types; the inert classes (calendar, monday, notion) enable no type');

-- Names an unbuilt executor would have: not allowed, and refused by propose for the service role with THE SPECIFIC refusal, on a REAL connection of the lane.
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id)
values ('00000000-0000-4000-8000-000000033400', 'PKG', 'google', 'types-owner@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test'));
create function pg_temp.refusal(p_type text) returns text language plpgsql as $$
begin
  perform core.act_propose('PKG', p_type, '00000000-0000-4000-8000-000000033400', '{"mailbox":"types-owner@g.example.test"}'::jsonb, '{"fromMailbox":"types-owner@g.example.test"}'::jsonb, 1, repeat('a', 64), null, '[]'::jsonb, 'user', pg_temp.uid('owner@example.test'), false);
  return 'accepted';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
-- the control: an allowed type on the same connection is accepted (so the refusals below are about the TYPE)
set local role service_role;
select is(pg_temp.refusal('email.save_draft'), 'accepted', 'control: an allowed type on this real connection is accepted');
select is((select coalesce(array_agg(t || ' => ' || pg_temp.refusal(t) order by t), '{}') from unnest(array[
    'monday.item.create', 'monday.item.update', 'monday.item.set_status', 'notion.page.update', 'calendar.event.create', 'calendar.event.update',
    'google.revoke_grant', 'qbo.post', 'qbo.delete', 'email.delete', 'email.forward', 'teams.chat.delete', 'teams.message.edit', 'payment.create', 'transfer.create']) t
  where pg_temp.refusal(t) is distinct from '42501 act: this action type is not allowed'), '{}'::text[],
  'types of unbuilt or forbidden writes are refused with exactly 42501 "act: this action type is not allowed" on a real connection (not by a later or unrelated error)');
reset role;
select is((select coalesce(array_agg(t order by t), '{}') from cand where act.is_allowed_type(t) and t not in (select t from reviewed_types)), '{}'::text[], 'none of the candidate names outside the reviewed list is an allowed type (calendar.*, monday.*, notion.*, google.revoke_grant ... all refused)');

-- The deny list stays in force over every allowed type.
select is((select coalesce(array_agg(t), '{}') from db_types where act.is_denied_type(t)), '{}'::text[], 'no allowed type matches the deny list');
-- Authenticated users reach no executor-side function: found from the catalog by what a function's SOURCE writes, across every app schema.
select is((select coalesce(array_agg(n.nspname || '.' || p.proname order by 1), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and p.prokind = 'f'
             and p.prosrc ~* '(update|insert into|delete from)\s+act\.(proposed_actions|execution_claims|status_history)'
             and has_function_privilege('authenticated', p.oid, 'execute') and n.nspname || '.' || p.proname not in ('act.approve', 'act.reject')), '{}'::text[],
  'the only functions that write the approval tables and are executable by authenticated are act.approve and act.reject (human approval and rejection)');
select is((select coalesce(array_agg(n.nspname || '.' || p.proname order by 1), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and p.prokind = 'f'
             and p.prosrc ~* 'act\.(claim_execution|claim_sent|mark_verified|mark_failed|reconcile_verified|reconcile_failed|expire_stale|insert_proposal|propose|supersede|withdraw_proposed)\('
             and has_function_privilege('authenticated', p.oid, 'execute')), '{}'::text[],
  'no function executable by authenticated calls an executor-side function (propose, claim, mark, reconcile, expire, supersede, withdraw)');

select * from finish();
rollback;
