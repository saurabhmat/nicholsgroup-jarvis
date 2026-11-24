-- T-286: Teams action types in the approvals database (docs/specs/messages.md 10.1, 10.2, 10.6).
-- Covered: the three types and the lane policy class; roles; the owner-only rule for propose / approve / reject / claim / read (cross-user: an admin, the lane owner, a viewer and a member without the
-- connection see and do nothing with another person's Teams action); CROSS-LANE denial; the gates at propose, approve and claim (approvals_live, teams_send, the connection's feature, the lane's teams
-- block); store_outbound_drafts; the shape of target and payload; the unique client request id; the step-up window per type (email unchanged); expiry; the text purged at EVERY terminal state;
-- the disconnect purge; grants; and regressions for email and qbo.disconnect (their behaviour is the one of the earlier tests 290, 308, 319, 325, which also run).
begin;
select plan(136);
\ir helpers/lane_rls.psql

create function pg_temp.claims_amr(p_email text, p_aal text, p_at bigint) returns text language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from auth.users where email = p_email), 'role', 'authenticated', 'aal', p_aal,
                      'amr', case when p_at is null then '[]'::json else json_build_array(json_build_object('method', 'totp', 'timestamp', p_at)) end)::text, true);
$$;
create function pg_temp.now_s(p_ago integer default 0) returns bigint language sql as $$ select (extract(epoch from now()) - p_ago)::bigint; $$;
-- one lane_config version with one top-level key merged (the config table is versioned)
create function pg_temp.cfg(p_lane text, p_key text, p_val jsonb) returns void language sql as $$
  insert into core.lane_config (lane_id, version, config)
  select lane_id, version + 1, jsonb_set(config, array[p_key], coalesce(config -> p_key, '{}'::jsonb) || p_val)
  from core.lane_config where lane_id = p_lane order by version desc limit 1;
$$;
create temp table ids (k text primary key, id uuid);
grant all on ids to public;
create function pg_temp.hash(p_n text) returns text language sql as $$ select encode(sha256(convert_to('hash-' || p_n, 'utf8')), 'hex'); $$;
create function pg_temp.rid(p_n integer) returns text language sql as $$ select '5e11d0c0-0000-4000-8000-' || lpad(p_n::text, 12, '0'); $$;
create function pg_temp.chat(p_n text default 'abc123') returns text language sql as $$ select '19:' || p_n || '@thread.v2'; $$;
create function pg_temp.t_chat(p_req integer, p_chat text default null) returns jsonb language sql as $$
  select jsonb_build_object('chat_id', coalesce(p_chat, pg_temp.chat()), 'client_request_id', pg_temp.rid(p_req));
$$;
create function pg_temp.t_payload(p_text text default 'CANARY text of a chat message') returns jsonb language sql as $$
  select jsonb_build_object('content_type', 'text', 'text', p_text);
$$;
-- propose as the service (the app's path); the person is the proposer
create function pg_temp.propose(p_lane text, p_type text, p_conn text, p_target jsonb, p_payload jsonb, p_hash text, p_email text, p_kind text default 'user') returns uuid language sql as $$
  select act.propose(p_lane, p_type, p_conn::uuid, p_target, p_payload, 1, p_hash, null, '[]', p_kind, pg_temp.uid(p_email), false);
$$;

update core.lanes set enabled = true where code = 'APK';
update core.lane_policies set store_outbound_drafts = true, write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id in ('PKG', 'APK');
select pg_temp.cfg(l, 'approvals', '{"approvals_live": true}') from unnest(array['PKG', 'APK']) l;
select pg_temp.cfg(l, 'teams', '{"enabled": true, "features": ["chat_read", "chat_send", "channels_read", "channels_send"]}') from unnest(array['PKG', 'APK']) l;

insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id) values
  ('00000000-0000-4000-8000-000000033001', 'PKG', 'microsoft_teams', 'robert@teams.example.test', 'active', '{"teams_chat_send": true, "teams_channels_send": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033002', 'PKG', 'microsoft_teams', 'saurabh@teams.example.test', 'active', '{"teams_chat_send": true, "teams_channels_send": true}', pg_temp.uid('admin-technical@example.test')),
  ('00000000-0000-4000-8000-000000033003', 'PKG', 'microsoft_teams', 'viewer@teams.example.test', 'active', '{"teams_chat_send": true}', pg_temp.uid('viewer@example.test')),
  ('00000000-0000-4000-8000-000000033004', 'APK', 'microsoft_teams', 'robert-apk@teams.example.test', 'active', '{"teams_chat_send": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033005', 'PKG', 'google', 'g-owner@example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033006', 'PKG', 'microsoft', 'ms-owner@example.test', 'active', '{"graph_mail_write": true}', pg_temp.uid('owner@example.test')),
  ('00000000-0000-4000-8000-000000033007', 'PKG', 'microsoft_teams', 'finance@teams.example.test', 'active', '{"teams_chat_send": true}', pg_temp.uid('finance-operator@example.test'));
-- a connection with no send feature at all
update core.connections set features = '{"teams_chat_send": false}' where id = '00000000-0000-4000-8000-000000033007';

-- ---------------------------------------------------------------- types, roles, policy class, helpers
select is((select act.is_allowed_type('teams.chat.send') and act.is_allowed_type('teams.channel.post') and act.is_allowed_type('teams.channel.reply')), true, 'the three Teams types are allowed action types');
select is((select act.is_allowed_type('teams.chat.delete') or act.is_allowed_type('teams.chat.edit') or act.is_allowed_type('teams.chat.create') or act.is_allowed_type('teams.')), false, 'no other teams.* type is allowed (no delete, edit, create)');
select is((select act.is_allowed_type('email.send') and act.is_allowed_type('email.save_draft') and act.is_allowed_type('qbo.disconnect') and not act.is_allowed_type('monday.item.create') and act.is_allowed_type(null) is not true), true, 'REGRESSION: email.* and qbo.disconnect stay allowed, nothing else is');
select is((select act.is_denied_type('teams.chat.send') or act.is_denied_type('teams.channel.post') or act.is_denied_type('teams.channel.reply')), false, 'the Teams types are not in a denied class');
select is((select act.write_roles('teams.chat.send') = array['owner', 'admin_technical'] and act.write_roles('teams.channel.post') = array['owner', 'admin_technical'] and act.write_roles('teams.channel.reply') = array['owner', 'admin_technical']), true, 'D-68 default: teams.* may be proposed and approved by owner and admin_technical');
select is((select act.write_roles('email.send') = array['owner', 'admin_technical'] and act.write_roles('qbo.disconnect') = array['owner', 'admin_technical'] and act.write_roles('monday.item.create') = array['owner']), true, 'REGRESSION: write_roles of email, qbo and other types are unchanged');
select lives_ok($$update core.lane_policies set write_actions_allowed = array['teams_send'] where lane_id = 'APK'$$, 'the lane policy class teams_send is accepted by the check');
select throws_ok($$update core.lane_policies set write_actions_allowed = array['teams_sends'] where lane_id = 'APK'$$, '23514', null, 'any other class is still refused by the check');
update core.lane_policies set write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id = 'APK';
select is((select act.expiry_hours('PKG', 'teams.chat.send')), 1, 'a Teams action expires after 1 hour by default');
select is((select act.expiry_hours('PKG', 'email.send')), 72, 'REGRESSION: email keeps 72 hours');
select pg_temp.cfg('PKG', 'approvals', '{"expire_after_hours": {"teams.chat.send": 3}}');
select is((select act.expiry_hours('PKG', 'teams.chat.send')), 3, 'a lane can set the Teams expiry');
select pg_temp.cfg('PKG', 'approvals', '{"expire_after_hours": {}}');
select is((select has_function_privilege('authenticated', 'act.is_teams_type(text)', 'execute') and not has_function_privilege('authenticated', 'act.teams_connection_ok(text, uuid, text)', 'execute') and not has_function_privilege('authenticated', 'act.teams_shape_ok(text, jsonb, jsonb)', 'execute') and not has_function_privilege('anon', 'act.is_teams_type(text)', 'execute')), true, 'grants: only the policy helper is executable by authenticated; the gates are definer-internal');
select is((select has_function_privilege('service_role', 'core.teams_actions_purge_connection(text, uuid)', 'execute') and not has_function_privilege('authenticated', 'core.teams_actions_purge_connection(text, uuid)', 'execute') and not has_function_privilege('anon', 'core.teams_actions_purge_connection(text, uuid)', 'execute')), true, 'the disconnect purge is service_role only');

-- ---------------------------------------------------------------- propose (service role): the happy path and every refusal
set local role service_role;
insert into ids select 'o1', pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(1), pg_temp.t_payload(), pg_temp.hash('o1'), 'owner@example.test');
insert into ids select 'a1', pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033002', pg_temp.t_chat(2), pg_temp.t_payload(), pg_temp.hash('a1'), 'admin-technical@example.test');
insert into ids select 'o2', pg_temp.propose('PKG', 'teams.channel.post', '00000000-0000-4000-8000-000000033001',
  jsonb_build_object('team_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'channel_id', '19:chan1@thread.tacv2', 'client_request_id', pg_temp.rid(3)), pg_temp.t_payload('Post line 1' || E'\n' || 'line 2' || E'\t' || 'tab 😀'), pg_temp.hash('o2'), 'owner@example.test');
insert into ids select 'o3', pg_temp.propose('PKG', 'teams.channel.reply', '00000000-0000-4000-8000-000000033001',
  jsonb_build_object('team_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'channel_id', '19:chan1@thread.tacv2', 'reply_to_id', '1700000000000', 'client_request_id', pg_temp.rid(4)), pg_temp.t_payload(), pg_temp.hash('o3'), 'owner@example.test');
insert into ids select 'x1', pg_temp.propose('APK', 'teams.chat.send', '00000000-0000-4000-8000-000000033004', pg_temp.t_chat(5), pg_temp.t_payload(), pg_temp.hash('x1'), 'owner@example.test');
reset role;
delete from core.memberships where lane_id = 'APK' and user_id = pg_temp.uid('owner@example.test'); -- APK is a lane the owner may NOT see from here on
select is((select count(*)::int from act.proposed_actions where action_type like 'teams.%'), 5, 'the owner and the admin can each propose on their OWN Teams connection (chat, channel post, channel reply; and one in another lane)');
select is((select provider from act.proposed_actions where id = (select id from ids where k = 'o1')), 'microsoft_teams', 'the action carries the connection''s provider microsoft_teams');
select is((select expires_at - created_at from act.proposed_actions where id = (select id from ids where k = 'o1')), interval '1 hour', 'a Teams proposal expires one hour after it was made');
select is((select payload ->> 'text' from act.proposed_actions where id = (select id from ids where k = 'o2')), 'Post line 1' || E'\n' || 'line 2' || E'\t' || 'tab 😀', 'newline, tab and an emoji are kept exactly in the stored text');

set local role service_role;
select throws_ok(format($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(10), pg_temp.t_payload(), pg_temp.hash('p'), 'admin-technical@example.test')$$), '42501', null, 'cross-user: another person (an admin) cannot propose on the owner''s Teams connection');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(11), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test', 'job')$$, '42501', null, 'a job cannot propose a Teams message (only a person''s own Send)');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033003', pg_temp.t_chat(12), pg_temp.t_payload(), pg_temp.hash('p'), 'viewer@example.test')$$, '42501', null, 'a viewer cannot propose, even on their own Teams connection (D-68 default)');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033005', pg_temp.t_chat(13), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '23503', null, 'a Google connection cannot carry a teams.* action');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033006', pg_temp.t_chat(14), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '23503', null, 'a Microsoft mail connection cannot carry a teams.* action');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033004', pg_temp.t_chat(15), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '23503', null, 'CROSS-LANE: another lane''s Teams connection named under PKG is refused');
select throws_ok($$select act.supersede('PKG', (select id from ids where k = 'o1'), pg_temp.t_chat(16), pg_temp.t_payload('edited'), 1, pg_temp.hash('s'), null, '[]', pg_temp.uid('owner@example.test'), false)$$, '42501', null, 'a Teams action cannot be edited (supersede): a new Send is a new action');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033007', pg_temp.t_chat(17), pg_temp.t_payload(), pg_temp.hash('p'), 'finance-operator@example.test')$$, '42501', null, 'a role outside owner and admin_technical (finance_operator) cannot propose');
-- shape
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(20, 'not-a-thread-id'), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: a chat id that is not 19:... is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(21) || '{"extra": "x"}', pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: an extra target key is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(22), pg_temp.t_payload('') , pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: empty text is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(23), pg_temp.t_payload(E' \n\t '), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: whitespace-only text is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(231), pg_temp.t_payload(' padded'), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: text with spaces at its ends is refused (the app trims, as its Zod schema requires)');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(24), pg_temp.t_payload(repeat('a', 10001)), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: more than 10,000 characters is refused');
select lives_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(25), pg_temp.t_payload(repeat('a', 10000)), pg_temp.hash('p25'), 'owner@example.test')$$, 'shape: exactly 10,000 characters is accepted');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(26), pg_temp.t_payload('bell' || chr(7)), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: a control character is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(27), pg_temp.t_payload('a' || E'\r' || 'b'), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: a carriage return is refused (the app writes newline only)');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(28), pg_temp.t_payload('e' || chr(769)), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: text that is not NFC is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(29), jsonb_build_object('content_type', 'html', 'text', 'x'), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: html is refused (plain text only)');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(30), pg_temp.t_payload() || '{"mentions": []}', pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: an extra payload key (mentions, attachments) is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.channel.reply', '00000000-0000-4000-8000-000000033001', jsonb_build_object('team_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'channel_id', '19:chan1@thread.tacv2', 'client_request_id', pg_temp.rid(31)), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: a channel reply without reply_to_id is refused');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', jsonb_build_object('chat_id', pg_temp.chat(), 'client_request_id', 'not-a-uuid'), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '22023', null, 'shape: the client request id must be a lower-case UUID');
-- one send per composed message
select is((select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(1), pg_temp.t_payload(), pg_temp.hash('o1'), 'owner@example.test')), (select id from ids where k = 'o1'), 'the same client request id with the same content returns the EXISTING action');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(1), pg_temp.t_payload('other text'), pg_temp.hash('other'), 'owner@example.test')$$, '23505', 'act: client_request_id_reused', 'the same client request id with different content is refused');
reset role;
select is((select count(*)::int from act.proposed_actions where connection_id = '00000000-0000-4000-8000-000000033001' and target ->> 'client_request_id' = pg_temp.rid(1)), 1, 'one row per client request id (unique index)');
select throws_ok($$insert into act.proposed_actions (lane_id, action_type, connection_id, provider, target, payload, payload_schema_version, payload_sha256, proposer_kind, proposer_user_id, expires_at)
  values ('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', 'microsoft_teams', pg_temp.t_chat(1), pg_temp.t_payload(), 1, repeat('a', 64), 'user', pg_temp.uid('owner@example.test'), now() + interval '1 hour')$$, '23505', null, 'the unique index itself refuses a second row with the same client request id');

-- gates at propose
update core.lane_policies set store_outbound_drafts = false where lane_id = 'PKG';
set local role service_role;
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(40), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, '42501', 'act: this lane does not allow storing outbound drafts', 'store_outbound_drafts off: no Teams text is stored');
reset role;
update core.lane_policies set store_outbound_drafts = true where lane_id = 'PKG';
update core.lane_policies set write_actions_allowed = array['email_send'] where lane_id = 'PKG';
set local role service_role;
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(41), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, 'P0001', 'act: type_not_allowed', 'the lane policy without teams_send refuses at propose');
reset role;
update core.lane_policies set write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id = 'PKG';
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": false}');
set local role service_role;
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(42), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, 'P0001', 'act: not_live', 'approvals_live false refuses at propose');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": true}');
select pg_temp.cfg('PKG', 'teams', '{"features": ["chat_read", "channels_read", "channels_send"]}');
set local role service_role;
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(43), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, 'P0001', 'act: connection_not_enabled', 'the lane''s teams.features without chat_send refuses a chat send at propose');
select lives_ok($$select pg_temp.propose('PKG', 'teams.channel.post', '00000000-0000-4000-8000-000000033001', jsonb_build_object('team_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'channel_id', '19:chan2@thread.tacv2', 'client_request_id', pg_temp.rid(44)), pg_temp.t_payload(), pg_temp.hash('p44'), 'owner@example.test')$$, '...while channels_send still allows a channel post');
reset role;
select pg_temp.cfg('PKG', 'teams', '{"features": ["chat_read", "chat_send", "channels_read", "channels_send"], "enabled": false}');
set local role service_role;
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(45), pg_temp.t_payload(), pg_temp.hash('p'), 'owner@example.test')$$, 'P0001', 'act: connection_not_enabled', 'teams.enabled false refuses at propose');
select throws_ok($$select pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033007', pg_temp.t_chat(46), pg_temp.t_payload(), pg_temp.hash('p'), 'finance-operator@example.test')$$, '42501', null, '(the finance member is refused by role before the feature)');
reset role;
select pg_temp.cfg('PKG', 'teams', '{"enabled": true}');

-- ---------------------------------------------------------------- read visibility: only the connection's owner
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where action_type like 'teams.%' and lane_id = 'PKG'), 5, 'the owner sees their own Teams actions (o1, o2, o3, and the two proposed later)');
select is((select count(*)::int from act.proposed_actions where id = (select id from ids where k = 'a1')), 0, 'cross-user: the lane OWNER cannot see the admin''s Teams action');
select is((select count(*)::int from act.status_history where action_id = (select id from ids where k = 'a1')), 0, 'cross-user: ...nor its status history');
select is((select count(*)::int from act.proposed_actions where lane_id = 'APK'), 0, 'CROSS-LANE: the owner sees no APK action');
select is((select count(*)::int from act.status_history where action_id = (select id from ids where k = 'x1')), 0, 'CROSS-LANE: ...nor its status history');
select throws_ok(format($$select core.act_approve('APK', %L, %L)$$, (select id from ids where k = 'x1'), pg_temp.hash('x1')), '42501', null, 'CROSS-LANE: the owner cannot approve another lane''s Teams action');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'x1'), pg_temp.hash('x1')), 'P0002', null, 'CROSS-LANE: naming it under PKG finds nothing');
select is((select count(*)::int from act.status_history where action_id = (select id from ids where k = 'o1')), 1, 'the owner sees the status history of their own Teams action');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where action_type like 'teams.%'), 1, 'the admin_technical sees only their own Teams action');
select is((select count(*)::int from act.proposed_actions where id = (select id from ids where k = 'o1')), 0, 'cross-user: an admin cannot see the owner''s Teams action, although admin_technical holds the approvals view');
select is((select count(*)::int from core.act_list('PKG') where action_type like 'teams.%'), 1, 'core.act_list shows the admin only their own Teams action');
select is((select core.act_pending_count('PKG')), 0, 'the waiting count (Home, Approvals page) does not count Teams sends: they have no waiting card (the admin''s own pending Teams action is not counted)');
reset role;
select pg_temp.claims_amr('viewer@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select is((select count(*)::int from act.proposed_actions where action_type like 'teams.%'), 0, 'a viewer sees no Teams action of anyone else');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal1', pg_temp.now_s());
set local role authenticated;
select is((select count(*)::int from act.proposed_actions), 0, 'AAL1: nothing is visible');
reset role;

-- ---------------------------------------------------------------- approve: owner only, AAL2, the gates, the step-up window per type
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'a1'), pg_temp.hash('a1')), 'P0002', null, 'cross-user: the lane owner cannot approve the admin''s Teams action (the same not_found as an unknown id)');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o1'), pg_temp.hash('o1')), 'P0002', null, 'cross-user: the admin cannot approve the owner''s Teams action');
select throws_ok(format($$select core.act_reject('PKG', %L, 'no')$$, (select id from ids where k = 'o1')), 'P0002', null, 'cross-user: ...nor reject it');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal1', pg_temp.now_s());
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o1'), pg_temp.hash('o1')), '42501', null, 'AAL1 cannot approve');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s(1000));
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o1'), pg_temp.hash('o1')), '42501', 'act: step_up_required', 'a code 1000 seconds old is refused for a Teams action by default (300 s, as email)');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": 3600}');
-- L1: with different windows per type, an id the caller cannot see must answer exactly like an unknown id (no existence oracle)
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', pg_temp.now_s(1000));
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o1'), pg_temp.hash('o1')), '42501', 'act: step_up_required', 'L1: an admin with an old code approving the owner''s Teams id gets step_up_required, the same as for an unknown id');
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, '00000000-0000-4000-8000-0000000000ee', pg_temp.hash('o1')), '42501', 'act: step_up_required', 'L1: ...which is what an unknown id answers');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s(1000));
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o1'), repeat('0', 64)), 'P0001', 'act: hash_mismatch', 'with a 3600 s Teams window the step-up passes and a wrong hash is refused');
select is(core.act_approve('PKG', (select id from ids where k = 'o1'), pg_temp.hash('o1')), pg_temp.hash('o1'), 'D-67 setting: a Teams action is approved with a code 1000 seconds old when teams_step_up_max_age_s is 3600');
reset role;
-- the same age is still refused for email (its window is step_up_max_age_s, unchanged)
set local role service_role;
insert into ids select 'e1', act.propose('PKG', 'email.send', '00000000-0000-4000-8000-000000033005', '{"mailbox":"g-owner@example.test"}', jsonb_build_object('fromMailbox', 'g-owner@example.test', 'to', jsonb_build_array('dana@sender.example.test'), 'cc', '[]'::jsonb, 'bcc', '[]'::jsonb, 'subject', 'S', 'bodyText', 'EMAIL CANARY'), 1, pg_temp.hash('e1'), null, '[]', 'user', pg_temp.uid('owner@example.test'), false);
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s(1000));
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'e1'), pg_temp.hash('e1')), '42501', 'act: step_up_required', 'REGRESSION: an email action still needs a code within step_up_max_age_s: the Teams window does not widen it');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": 100}');
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s(250));
set local role authenticated;
select is(core.act_approve('PKG', (select id from ids where k = 'o3'), pg_temp.hash('o3')), pg_temp.hash('o3'), 'a Teams setting below 300 is raised to 300 (never below the email default)');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"teams_step_up_max_age_s": 3600}');
-- fresh step-up from here on
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select is(core.act_approve('PKG', (select id from ids where k = 'e1'), pg_temp.hash('e1')), pg_temp.hash('e1'), 'REGRESSION: the owner approves the email action on their mailbox with a fresh code');

-- gates at approve (each one off in turn; o2 is a channel post)
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o2'), repeat('1', 64)), 'P0001', 'act: hash_mismatch', 'a hash the person did not see is refused');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": false}');
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o2'), pg_temp.hash('o2')), 'P0001', 'act: not_live', 'approvals_live false refuses the approve');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": true}');
update core.lane_policies set write_actions_allowed = array['email_send'] where lane_id = 'PKG';
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o2'), pg_temp.hash('o2')), 'P0001', 'act: type_not_allowed', 'a lane policy without teams_send refuses the approve');
reset role;
update core.lane_policies set write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id = 'PKG';
update core.connections set features = '{"teams_chat_send": true, "teams_channels_send": false}' where id = '00000000-0000-4000-8000-000000033001';
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o2'), pg_temp.hash('o2')), 'P0001', 'act: connection_not_enabled', 'a connection without teams_channels_send refuses a channel post');
reset role;
update core.connections set features = '{"teams_chat_send": true, "teams_channels_send": true}' where id = '00000000-0000-4000-8000-000000033001';
select pg_temp.cfg('PKG', 'teams', '{"features": ["chat_read", "chat_send"]}');
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o2'), pg_temp.hash('o2')), 'P0001', 'act: connection_not_enabled', 'the lane''s teams.features without channels_send refuses a channel post');
reset role;
select pg_temp.cfg('PKG', 'teams', '{"features": ["chat_read", "chat_send", "channels_read", "channels_send"]}');
update core.connections set status = 'reconnect_required' where id = '00000000-0000-4000-8000-000000033001';
set local role authenticated;
select throws_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'o2'), pg_temp.hash('o2')), 'P0001', 'act: connection_not_enabled', 'a Teams connection that needs a reconnect refuses the approve');
reset role;
update core.connections set status = 'active' where id = '00000000-0000-4000-8000-000000033001';

-- reject by the owner: the text is purged at once
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select lives_ok(format($$select core.act_reject('PKG', %L, 'changed my mind')$$, (select id from ids where k = 'o2')), 'the owner rejects their own Teams action');
reset role;
select is((select payload ? 'text' from act.proposed_actions where id = (select id from ids where k = 'o2')), false, 'the text is purged when the action is rejected');
select is((select payload_purged_at is not null and target ->> 'client_request_id' = pg_temp.rid(3) and payload_sha256 = pg_temp.hash('o2') and payload ->> 'content_type' = 'text' from act.proposed_actions where id = (select id from ids where k = 'o2')), true, '...keeping target, hash, type and the content type');

-- ---------------------------------------------------------------- claim: single, owner re-checked, gates re-checked
set local role service_role;
select is((select (core.act_claim_execution('PKG', (select id from ids where k = 'o1'))).status), 'executing', 'the service claims the approved Teams action');
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'o1')), 'P0001', 'act: not_approved', 'a second claim is refused (one execution)');
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'x1')), 'P0002', null, 'CROSS-LANE: an APK action cannot be claimed under PKG');
reset role;
select is((select payload ->> 'text' from act.proposed_actions where id = (select id from ids where k = 'o1')), 'CANARY text of a chat message', 'while the action is executing the text is still held (the reconciler needs it)');
select is((select count(*)::int from act.execution_claims where action_id = (select id from ids where k = 'o1')), 1, 'exactly one claim row exists');
-- a claim is refused when a gate is off or the approver changed
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": false}');
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'o3')), 'P0001', 'act: not_live', 'approvals_live false refuses the claim');
reset role;
select pg_temp.cfg('PKG', 'approvals', '{"approvals_live": true}');
update core.lane_policies set write_actions_allowed = array['email_send'] where lane_id = 'PKG';
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'o3')), 'P0001', 'act: type_not_allowed', 'a lane policy without teams_send refuses the claim');
reset role;
update core.lane_policies set write_actions_allowed = array['teams_send', 'email_send', 'email_draft', 'qbo_disconnect'] where lane_id = 'PKG';
select pg_temp.cfg('PKG', 'teams', '{"features": ["chat_read", "chat_send"]}');
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'o3')), 'P0001', 'act: connection_not_enabled', 'the lane''s feature turned off after approval refuses the claim (channel reply)');
reset role;
select pg_temp.cfg('PKG', 'teams', '{"features": ["chat_read", "chat_send", "channels_read", "channels_send"]}');
update core.connections set features = '{}' where id = '00000000-0000-4000-8000-000000033001';
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'o3')), 'P0001', 'act: connection_not_enabled', 'a connection that lost its send feature refuses the claim');
reset role;
update core.connections set features = '{"teams_chat_send": true, "teams_channels_send": true}' where id = '00000000-0000-4000-8000-000000033001';
-- the admin's own action: approve, then the admin loses the role: the claim is refused
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select is(core.act_approve('PKG', (select id from ids where k = 'a1'), pg_temp.hash('a1')), pg_temp.hash('a1'), 'the admin_technical approves their own Teams action');
reset role;
update core.memberships set role = 'viewer' where lane_id = 'PKG' and user_id = pg_temp.uid('admin-technical@example.test');
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a1')), 'P0001', 'act: approver_revoked', 'an approver who lost the role is refused at the claim');
reset role;
update core.memberships set role = 'admin_technical' where lane_id = 'PKG' and user_id = pg_temp.uid('admin-technical@example.test');
-- expiry
alter table act.proposed_actions disable trigger proposed_actions_guard;
update act.proposed_actions set expires_at = now() - interval '1 minute' where id = (select id from ids where k = 'o3');
alter table act.proposed_actions enable trigger proposed_actions_guard;
set local role service_role;
select throws_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'o3')), 'P0001', 'act: expired', 'an expired approved action cannot be claimed');
select is((select core.act_expire_stale('PKG')), 1, 'act.expire_stale expires it');
reset role;
select is((select status || ':' || (payload ? 'text')::text from act.proposed_actions where id = (select id from ids where k = 'o3')), 'expired:false', 'the text is purged when the action expires');

-- ---------------------------------------------------------------- the text is purged at EVERY terminal state
set local role service_role;
select lives_ok(format($$select core.act_claim_sent('PKG', %L, 'synthetic-message-1')$$, (select id from ids where k = 'o1')), 'the claim records the id of the sent message');
select lives_ok(format($$select core.act_mark_verified('PKG', %L, 'synthetic-message-1', 'accepted')$$, (select id from ids where k = 'o1')), 'verified');
reset role;
select is((select status || ':' || (payload ? 'text')::text || ':' || (payload_purged_at is not null)::text from act.proposed_actions where id = (select id from ids where k = 'o1')), 'verified:false:true', 'the text is purged when the action is verified');
select is((select count(*)::int from act.proposed_actions where action_type like 'teams.%' and status in ('verified', 'failed', 'rejected', 'expired', 'invalidated') and payload ? 'text'), 0, 'no terminal Teams action keeps its text');
-- failed (a fresh pair), through the claim
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', pg_temp.now_s());
set local role service_role;
select lives_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'a1')), 'the admin''s approved action is claimed (the role is back)');
select lives_ok(format($$select core.act_mark_failed('PKG', %L, 'throttled', 'error')$$, (select id from ids where k = 'a1')), 'failed');
reset role;
select is((select status || ':' || (payload ? 'text')::text from act.proposed_actions where id = (select id from ids where k = 'a1')), 'failed:false', 'the text is purged when the action fails');
-- invalidated and failed by a disconnect
set local role service_role;
insert into ids select 'd1', pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(60), pg_temp.t_payload('disconnect canary one'), pg_temp.hash('d1'), 'owner@example.test');
insert into ids select 'd2', pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033001', pg_temp.t_chat(61), pg_temp.t_payload('disconnect canary two'), pg_temp.hash('d2'), 'owner@example.test');
reset role;
select pg_temp.claims_amr('owner@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'd2'), pg_temp.hash('d2')), 'd2 is approved');
reset role;
set local role service_role;
select lives_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'd2')), 'd2 is claimed (executing)');
select cmp_ok((select core.teams_actions_purge_connection('PKG', '00000000-0000-4000-8000-000000033001')), '>=', 2, 'the disconnect purge closes the open actions of the connection');
reset role;
select is((select string_agg(status || ':' || (payload ? 'text')::text, ',' order by id::text) from act.proposed_actions where id = (select id from ids where k = 'd1')), 'invalidated:false', 'a proposed action of a disconnected connection is invalidated and its text purged');
select is((select status || ':' || failure_code || ':' || (payload ? 'text')::text from act.proposed_actions where id = (select id from ids where k = 'd2')), 'failed:reconcile_connection_disconnected:false', 'an executing action ends failed / reconcile_connection_disconnected with its text purged');
select is((select act.is_unknown_failure(failure_code) from act.proposed_actions where id = (select id from ids where k = 'd2')), true, 'H1: that code is an UNKNOWN-outcome code (the message may have been delivered: the person is told to check Teams)');
select is((select status || ':' || coalesce(failure_code, '-') from act.proposed_actions where id = (select id from ids where k = 'd1')), 'invalidated:-', 'H1: a proposed action that was never claimed is invalidated with no failure code (nothing was sent)');
select throws_ok($$select core.teams_actions_purge_connection('APK', '00000000-0000-4000-8000-000000033001')$$, 'P0002', null, 'the purge is lane-checked: another lane''s name for the connection is refused');
select throws_ok($$select core.teams_actions_purge_connection('PKG', '00000000-0000-4000-8000-000000033005')$$, 'P0002', null, '...and a connection that is not a Teams connection is refused');
select is((select core.act_claim_outcome('PKG', (select id from ids where k = 'd2'))), 'outcome_unknown', 'the claim outcome function reports the recorded outcome');
select is((select core.act_claim_outcome('PKG', (select id from ids where k = 'x1'))), null, '...null when the action has no claim, and nothing from another lane (x1 is APK''s)');
select is((select outcome from act.execution_claims where action_id = (select id from ids where k = 'd2')), 'outcome_unknown', '...and its claim says the outcome is unknown (it may have been sent)');
select is((select count(*)::int from act.proposed_actions where action_type like 'teams.%' and connection_id = '00000000-0000-4000-8000-000000033004' and status = 'proposed'), 1, 'CROSS-LANE: the purge of one connection leaves another lane''s connection alone');
select throws_ok($$select core.teams_actions_purge_connection('PKG', null)$$, '22004', null, 'the purge needs a lane and a connection');
set local role service_role;
select is((select core.act_claimed_external_ids('PKG', '00000000-0000-4000-8000-000000033001', null, array['synthetic-message-1', 'synthetic-message-2'])), array['synthetic-message-1'], 'M-B: the message id another action recorded is reported (ids only), and an unknown one is not');
select is((select core.act_claimed_external_ids('PKG', '00000000-0000-4000-8000-000000033001', (select id from ids where k = 'o1'), array['synthetic-message-1'])), '{}'::text[], 'M-B: ...but not for the action that owns it (the except argument)');
select is((select core.act_claimed_external_ids('APK', '00000000-0000-4000-8000-000000033001', null, array['synthetic-message-1'])), '{}'::text[], 'M-B: CROSS-LANE: the same connection named under another lane yields nothing');
reset role;
select is((select has_function_privilege('authenticated', 'core.act_claimed_external_ids(text, uuid, uuid, text[])', 'execute') or has_function_privilege('authenticated', 'core.act_claim_outcome(text, uuid)', 'execute') or has_function_privilege('anon', 'core.act_claim_outcome(text, uuid)', 'execute')), false, 'the two claim readers are service_role only');
select pg_temp.claims_amr('owner@example.test', 'aal1', pg_temp.now_s());
set local role authenticated;
select is(core.has_lane_role(pg_temp.uid('owner@example.test'), 'PKG', array['owner']), false, 'L5: at AAL1 even the owner holds no role, so the module''s role check (made before any text is stored) refuses an AAL1 session');
reset role;

-- ---------------------------------------------------------------- reconcile reads (service role): a Teams action stays findable while executing
update core.connections set features = '{"teams_chat_send": true, "teams_channels_send": true}' where id = '00000000-0000-4000-8000-000000033002';
set local role service_role;
insert into ids select 'r1', pg_temp.propose('PKG', 'teams.chat.send', '00000000-0000-4000-8000-000000033002', pg_temp.t_chat(70), pg_temp.t_payload('reconcile canary'), pg_temp.hash('r1'), 'admin-technical@example.test');
reset role;
select pg_temp.claims_amr('admin-technical@example.test', 'aal2', pg_temp.now_s());
set local role authenticated;
select lives_ok(format($$select core.act_approve('PKG', %L, %L)$$, (select id from ids where k = 'r1'), pg_temp.hash('r1')), 'r1 approved');
reset role;
set local role service_role;
select lives_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'r1')), 'r1 claimed');
reset role;
update act.proposed_actions set executing_at = now() - interval '30 minutes' where id = (select id from ids where k = 'r1');
set local role service_role;
select is((select count(*)::int from core.act_stuck_actions('PKG') s where (s.action ->> 'id')::uuid = (select id from ids where k = 'r1') and s.action -> 'payload' ->> 'text' = 'reconcile canary'), 1, 'the sweep lists the executing Teams action with its text (it is needed for the lookup)');
select is((select core.act_reconcile_verified('PKG', (select id from ids where k = 'r1'), 'synthetic-message-9', 'already_applied')), true, 'the reconciler can verify it');
reset role;
select is((select status || ':' || (payload ? 'text')::text from act.proposed_actions where id = (select id from ids where k = 'r1')), 'verified:false', 'the text is purged when the reconciler verifies');

-- ---------------------------------------------------------------- regressions: email and qbo.disconnect behave as before
select is((select status || ':' || (payload ? 'bodyText')::text || ':' || (payload ? 'text')::text from act.proposed_actions where id = (select id from ids where k = 'e1')), 'approved:true:false', 'REGRESSION: an approved email still holds its bodyText');
set local role service_role;
select lives_ok(format($$select core.act_claim_execution('PKG', %L)$$, (select id from ids where k = 'e1')), 'REGRESSION: the approved email is claimed as before');
select lives_ok(format($$select core.act_mark_failed('PKG', %L, 'execution_refused', 'error')$$, (select id from ids where k = 'e1')), '...and ends failed');
reset role;
select is((select status || ':' || (payload ? 'bodyText')::text from act.proposed_actions where id = (select id from ids where k = 'e1')), 'failed:false', 'REGRESSION: the email bodyText is purged at the terminal state, as before');
select is((select act.type_allowed('PKG', 'email.send') and act.type_allowed('PKG', 'email.save_draft') and act.type_allowed('PKG', 'qbo.disconnect') and act.type_allowed('PKG', 'teams.chat.send')), true, 'type_allowed: every class maps to its own policy value');
update core.lane_policies set write_actions_allowed = array['email_send'] where lane_id = 'PKG';
select is((select act.type_allowed('PKG', 'email.send') and not act.type_allowed('PKG', 'email.save_draft') and not act.type_allowed('PKG', 'qbo.disconnect') and not act.type_allowed('PKG', 'teams.chat.send') and not act.type_allowed('PKG', 'teams.channel.post') and not act.type_allowed('PKG', 'teams.channel.reply')), true, 'type_allowed: email_send alone allows neither Teams nor qbo');

select * from finish();
rollback;
