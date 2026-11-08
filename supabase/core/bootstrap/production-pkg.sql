-- One-time PRODUCTION bootstrap for the Pub K Group lane (run by Saurabh in the Supabase SQL editor of project
-- lxjhaxdkqtmkhloqaffb, AFTER all migrations are applied and AFTER the owner has signed in once, so the auth user
-- exists). Agents never run this. Idempotent: safe to run twice. No vendor ids or secrets: QuickBooks, Stripe,
-- GoHighLevel and mailbox settings are added later through lane_config / the connect flows, never here.
--
-- Before running: replace the email below with the owner's sign-in email (it must already exist in auth.users).
begin;

-- 1. The company (lane).
insert into core.lanes (code, name, data_plane, enabled)
values ('PKG', 'Pub K Group', 'core', true)
on conflict (code) do update set enabled = true;

-- 2. The lane policy. The assistant may read mail and calendar metadata (the demo tools); content bodies are not
--    stored; retention 90 days. Widen later deliberately (finance with T-104, docs, tasks).
insert into core.lane_policies (lane_id, llm_allowed_categories, store_content_bodies, store_outbound_drafts, indexing_enabled, retention_days, cross_lane_summary_allowed, write_actions_allowed)
values ('PKG', array['email', 'calendar']::text[], false, false, false, 90, 'none', array[]::text[])
on conflict (lane_id) do update set llm_allowed_categories = excluded.llm_allowed_categories;

-- 3. The owner: portal user row + owner membership in PKG.
do $$
declare
  v_email constant text := 'REPLACE_WITH_OWNER_EMAIL@pubkgroup.com';
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then
    raise exception 'No auth user for %: sign in once on the portal first (email code), then run this again.', v_email;
  end if;
  insert into core.users (id, display_name) values (v_uid, 'Saurabh Gopal')
  on conflict (id) do nothing;
  insert into core.memberships (user_id, lane_id, role) values (v_uid, 'PKG', 'owner')
  on conflict (user_id, lane_id) do update set role = 'owner', views = '{}';
end;
$$;

-- Check: one enabled lane, its policy, and the owner membership.
select l.code, l.enabled, lp.llm_allowed_categories, m.role, u.email
from core.lanes l
join core.lane_policies lp on lp.lane_id = l.code
left join core.memberships m on m.lane_id = l.code
left join auth.users u on u.id = m.user_id
where l.code = 'PKG';

commit;
