-- T-170 (security suite), area 6, database side. Catalog-driven: the set of action types is READ from the definition of act.is_allowed_type and
-- the set of lane policy classes from the check constraint, so a new type or class fails here until it is classified below.
--   * every allowed type is in the reviewed list with its policy class, roles and executor family;
--   * a type outside the list, and the names a monday.com / Notion / calendar / Google-revoke action would have, cannot be proposed;
--   * the policy classes `calendar`, `monday`, `notion` (accepted by the lane policy but backed by no type or executor) enable nothing;
--   * for each type, act.type_allowed is true only for its own class: no class enables another type.
begin;
select plan(10);
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

-- Types as the database defines them (parsed from the function body).
create temp table db_types on commit drop as
  select m[1] as t from regexp_matches(pg_get_functiondef('act.is_allowed_type(text)'::regprocedure), '''([a-z_.]+)''', 'g') m;
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

-- Names an unbuilt executor would have: not allowed, and refused by propose even for the service role.
create function pg_temp.refused(p_type text) returns boolean language plpgsql as $$
begin
  perform core.act_propose('PKG', p_type, '00000000-0000-4000-8000-0000000000ff', '{}'::jsonb, '{}'::jsonb, 1, repeat('a', 64), null, '[]'::jsonb, 'user', null, false);
  return false;
exception when others then return true;
end $$;
set local role service_role;
select is((select coalesce(array_agg(t order by t), '{}') from unnest(array[
    'monday.item.create', 'monday.item.update', 'monday.item.set_status', 'notion.page.update', 'calendar.event.create', 'calendar.event.update',
    'google.revoke_grant', 'qbo.post', 'qbo.delete', 'email.delete', 'email.forward', 'teams.chat.delete', 'teams.message.edit', 'payment.create', 'transfer.create']) t
  where not pg_temp.refused(t)), '{}'::text[],
  'types of unbuilt or forbidden writes (monday, notion, calendar, google revoke, deletes, payments) cannot be proposed and are not allowed');
reset role;
select is((select coalesce(array_agg(t order by t), '{}') from unnest(array['monday.item.create','monday.item.update','monday.item.set_status','notion.page.update','calendar.event.create','calendar.event.update','google.revoke_grant','qbo.post','qbo.delete','email.delete','email.forward','teams.chat.delete','teams.message.edit','payment.create','transfer.create']) t where act.is_allowed_type(t)), '{}'::text[], 'none of those names is an allowed type');

-- The deny list stays in force over every allowed type.
select is((select coalesce(array_agg(t), '{}') from db_types where act.is_denied_type(t)), '{}'::text[], 'no allowed type matches the deny list');
-- Authenticated users reach no executor-side function.
select is((select coalesce(array_agg(p.proname::text order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'act' and p.proname in ('propose','supersede','claim_execution','claim_sent','mark_verified','mark_failed','reconcile_verified','reconcile_failed','expire_stale','insert_proposal')
             and has_function_privilege('authenticated', p.oid, 'execute')), '{}'::text[],
  'authenticated cannot execute propose, claim, mark, reconcile or expire (executor side is service-only)');

select * from finish();
rollback;
