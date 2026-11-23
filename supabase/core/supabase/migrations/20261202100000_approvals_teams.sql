-- T-286: Teams action types in the approvals database (docs/specs/messages.md section 10.1, 10.2, 10.6; decisions D-65, D-67 (open, default kept), D-68 (default), D-19).
-- A message in a Teams chat or channel is an external write, so it is an approvals action like an email: proposal -> the connection's OWNER approves the exact payload -> execute once -> verify -> audit.
--   * Types: teams.chat.send, teams.channel.post, teams.channel.reply (act.is_allowed_type). Lane policy class `teams_send` (lane_policies check, act.type_allowed).
--   * Roles: owner and admin_technical (act.write_roles; D-68 asks whether a viewer may send from their own account: default no, one line here if the answer changes).
--   * OWNER ONLY: a teams.* action is proposed, approved, rejected, claimed and seen only by the person who owns its Teams connection (core.teams_connection_ids), exactly as T-247 does for a mailbox.
--     An admin (even one holding the approvals view) sees nothing of another person's Teams actions: the select policy, the history and the claim rows follow the connection's owner.
--   * Gates, each refused when off at propose, approve AND claim (defence in depth): approvals_live, the lane policy class teams_send, the connection (provider microsoft_teams, usable,
--     features.teams_chat_send / teams_channels_send) and the lane's teams.enabled + teams.features (chat_send / channels_send): act.teams_connection_ok.
--   * Text: stored in payload.text only while the action is open and only when lane_policies.store_outbound_drafts (D-19 (a)); act.proposed_actions_guard removes it in the same statement as every
--     terminal transition (verified, failed, rejected, expired, invalidated: supersede is invalidated), keeping target, hash, type and timestamps.
--   * Shape: act.teams_shape_ok validates target and payload (the same rules as the app's Zod schemas): exact keys, ids in their documented formats, text 1..10,000 characters, NFC, at most
--     80 KB as UTF-8, no control characters except newline and tab, content_type "text" (no HTML, mentions, images or attachments).
--   * One send per composed message: unique (connection_id, target->>'client_request_id') for teams.* types; a repeated request with the same id and the same content returns the existing action.
--   * Step-up: act.approve reads approvals.teams_step_up_max_age_s (300 to 43,200, default 300 until D-67 is decided) for teams.* and step_up_max_age_s for every other type, unchanged.
--   * Expiry: teams.* default to 1 hour (act.expiry_hours; a lane may set approvals.expire_after_hours.<type>), since a Teams action is approved at once.
--   * Disconnect: core.teams_actions_purge_connection (service_role) invalidates the open teams.* actions of a disconnected connection (text purged) and ends an executing one failed / outcome_unknown.
-- Every other action type behaves exactly as before: each replaced function keeps its old behaviour for email.*, qbo.disconnect (the diff of each body is listed in .agent/pr/T-286.md).
-- Replaced: act.is_allowed_type, act.type_allowed, act.write_roles, act.expiry_hours, act.connection_ok, act.proposed_actions_guard, act.insert_proposal, act.approve, act.reject, act.claim_execution,
-- act.action_rows_visible, policy proposed_actions_select, the lane_policies and proposed_actions provider checks. Added: act.is_teams_type, act.teams_connection_ok, act.teams_shape_ok,
-- the unique index proposed_actions_teams_request_uidx, core.teams_actions_purge_connection. No new table: act.* tables keep lane_id and their RLS; the Teams rows are covered by the same policies.
-- Tests: 330_approvals_teams.test.sql (incl. cross-lane and cross-user denial); 290, 291, 302, 304, 306, 308, 319, 325 unchanged and passing.

-- ---------------------------------------------------------------- lane policy class and provider
alter table core.lane_policies drop constraint if exists lane_policies_write_actions_allowed_check;
alter table core.lane_policies add constraint lane_policies_write_actions_allowed_check
  check (write_actions_allowed <@ array['email_draft', 'email_send', 'calendar', 'monday', 'notion', 'qbo_disconnect', 'teams_send']::text[]);

alter table act.proposed_actions drop constraint if exists proposed_actions_provider_check;
alter table act.proposed_actions add constraint proposed_actions_provider_check check (provider in ('google', 'microsoft', 'quickbooks', 'microsoft_teams'));

-- ---------------------------------------------------------------- helpers
create function act.is_teams_type(p_type text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('teams.chat.send', 'teams.channel.post', 'teams.channel.reply');
$$;
revoke all on function act.is_teams_type(text) from public, anon, authenticated;
grant execute on function act.is_teams_type(text) to authenticated, service_role; -- used by the select policy

create or replace function act.is_allowed_type(p_type text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('email.send', 'email.save_draft', 'qbo.disconnect', 'teams.chat.send', 'teams.channel.post', 'teams.channel.reply');
$$;

create or replace function act.write_roles(p_type text) returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
    when p_type = 'qbo.disconnect' then array['owner', 'admin_technical']::text[]
    when p_type like 'email.%' then array['owner', 'admin_technical']::text[] -- T-247: whoever owns the mailbox (the owner check is the gate)
    when p_type like 'teams.%' then array['owner', 'admin_technical']::text[] -- T-286 (D-68 default): whoever owns the Teams connection (the owner check is the gate)
    else array['owner']::text[]
  end;
$$;
revoke all on function act.write_roles(text) from public, anon, authenticated;

create or replace function act.type_allowed(p_lane text, p_type text) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.lane_policies p
    where p.lane_id = p_lane
      and ((p_type = 'email.send' and 'email_send' = any (p.write_actions_allowed))
        or (p_type = 'email.save_draft' and 'email_draft' = any (p.write_actions_allowed))
        or (p_type = 'qbo.disconnect' and 'qbo_disconnect' = any (p.write_actions_allowed))
        or (p_type in ('teams.chat.send', 'teams.channel.post', 'teams.channel.reply') and 'teams_send' = any (p.write_actions_allowed)))
  );
$$;

create or replace function act.expiry_hours(p_lane text, p_type text) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when c.config -> 'approvals' -> 'expire_after_hours' ->> p_type ~ '^[0-9]{1,3}$'
                 then (c.config -> 'approvals' -> 'expire_after_hours' ->> p_type)::integer end
     from core.lane_config_current c where c.lane_id = p_lane),
    case when p_type like 'teams.%' then 1 else 72 end); -- T-286: a Teams action is approved at once, so it expires after an hour unless the lane says otherwise
$$;

-- The Teams connection of a send is usable for its type: provider microsoft_teams, active or degraded, the connection holds the send feature (recorded at the last connect from the granted
-- scopes), and the LANE has Teams enabled with the matching feature on (lane_config.teams). Reads the authoritative rows (definer-only helper).
create function act.teams_connection_ok(p_lane text, p_connection uuid, p_type text) returns boolean
language sql
stable
set search_path = ''
as $$
  select p_type in ('teams.chat.send', 'teams.channel.post', 'teams.channel.reply') and exists (
    select 1
    from core.connections c
    join core.lane_config_current lc on lc.lane_id = c.lane_id
    where c.id = p_connection and c.lane_id = p_lane
      and c.provider = 'microsoft_teams' and c.status in ('active', 'degraded')
      and c.features ->> (case when p_type = 'teams.chat.send' then 'teams_chat_send' else 'teams_channels_send' end) = 'true'
      and lc.config -> 'teams' ->> 'enabled' = 'true'
      and pg_catalog.jsonb_typeof(lc.config -> 'teams' -> 'features') = 'array'
      and (lc.config -> 'teams' -> 'features') ? (case when p_type = 'teams.chat.send' then 'chat_send' else 'channels_send' end));
$$;
comment on function act.teams_connection_ok(text, uuid, text) is 'T-286: the Teams connection is usable for this send type: microsoft_teams, active/degraded, the connection feature and the lane''s teams.enabled + feature are on.';
revoke all on function act.teams_connection_ok(text, uuid, text) from public, anon, authenticated;

-- The shape of a teams.* target and payload (the same rules as the app's Zod schemas, packages/connectors/src/teams/send-schema.ts). The exact key sets, the id formats of Graph
-- (a thread id is `19:...` up to 200 characters in all), a lower-case UUID for the team and the client request, text 1 to 10,000 characters that is NFC, at most 80 KB as UTF-8,
-- not blank, and with no control character except newline and tab. Anything else is false.
create function act.teams_shape_ok(p_type text, p_target jsonb, p_payload jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p_target) = 'object' and pg_catalog.jsonb_typeof(p_payload) = 'object'
    and (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(p_payload) = 'object' then p_payload else '{}'::jsonb end) k) = array['content_type', 'text']::text[]
    and p_payload ->> 'content_type' = 'text'
    and pg_catalog.jsonb_typeof(p_payload -> 'text') = 'string'
    and pg_catalog.char_length(p_payload ->> 'text') between 1 and 10000
    and pg_catalog.octet_length(p_payload ->> 'text') <= 81920
    and (p_payload ->> 'text') is nfc normalized
    and (p_payload ->> 'text') !~ '[\u0001-\u0008\u000b-\u001f\u007f-\u009f]'
    and pg_catalog.btrim(p_payload ->> 'text', E' \t\n') <> ''
    and pg_catalog.jsonb_typeof(p_target -> 'client_request_id') = 'string'
    and p_target ->> 'client_request_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and case p_type
          when 'teams.chat.send' then
            (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(p_target) = 'object' then p_target else '{}'::jsonb end) k) = array['chat_id', 'client_request_id']::text[]
            and pg_catalog.jsonb_typeof(p_target -> 'chat_id') = 'string'
            and p_target ->> 'chat_id' ~ '^19:[A-Za-z0-9._@:-]{1,197}$'
          when 'teams.channel.post' then
            (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(p_target) = 'object' then p_target else '{}'::jsonb end) k) = array['channel_id', 'client_request_id', 'team_id']::text[]
            and pg_catalog.jsonb_typeof(p_target -> 'team_id') = 'string' and pg_catalog.jsonb_typeof(p_target -> 'channel_id') = 'string'
            and p_target ->> 'team_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and p_target ->> 'channel_id' ~ '^19:[A-Za-z0-9._@:-]{1,197}$'
          when 'teams.channel.reply' then
            (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(case when pg_catalog.jsonb_typeof(p_target) = 'object' then p_target else '{}'::jsonb end) k) = array['channel_id', 'client_request_id', 'reply_to_id', 'team_id']::text[]
            and pg_catalog.jsonb_typeof(p_target -> 'team_id') = 'string' and pg_catalog.jsonb_typeof(p_target -> 'channel_id') = 'string' and pg_catalog.jsonb_typeof(p_target -> 'reply_to_id') = 'string'
            and p_target ->> 'team_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and p_target ->> 'channel_id' ~ '^19:[A-Za-z0-9._@:-]{1,197}$'
            and p_target ->> 'reply_to_id' ~ '^[A-Za-z0-9._:=@-]+$' and pg_catalog.char_length(p_target ->> 'reply_to_id') <= 256
          else false
        end,
    false);
$$;
comment on function act.teams_shape_ok(text, jsonb, jsonb) is 'T-286: the exact target and payload of a teams.* action (keys, id formats, text rules). The app''s Zod schemas say the same.';
revoke all on function act.teams_shape_ok(text, jsonb, jsonb) from public, anon, authenticated;

-- The connection of an action is usable for its type: email needs a Google connection that was granted compose or a Microsoft one granted graph_mail_write; qbo.disconnect needs the lane's
-- QuickBooks connection that is not yet disconnected and is the realm the action names; teams.* needs a usable Teams connection with the send feature, in a lane that has it on.
create or replace function act.connection_ok(p_lane text, p_row act.proposed_actions) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.connections c
    where c.id = p_row.connection_id and c.lane_id = p_lane
      and case
            when p_row.action_type = 'qbo.disconnect' then
              c.provider = 'quickbooks' and c.status in ('active', 'degraded', 'reconnect_required')
              and p_row.target = pg_catalog.jsonb_build_object('realm_id', c.external_account_id)
            when act.is_teams_type(p_row.action_type) then
              c.provider = 'microsoft_teams' and p_row.provider = 'microsoft_teams'
              and act.teams_connection_ok(p_lane, c.id, p_row.action_type)
            else
              c.status in ('active', 'degraded')
              and c.provider = p_row.provider
              and case c.provider
                    when 'google' then c.features ->> 'gmail_compose' = 'true'
                    when 'microsoft' then c.features ->> 'graph_mail_write' = 'true'
                    else false
                  end
          end);
$$;
revoke all on function act.connection_ok(text, act.proposed_actions) from public, anon, authenticated;

-- ---------------------------------------------------------------- state machine: the text of a Teams message is removed with every terminal state
create or replace function act.proposed_actions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_terminal constant text[] := array['verified', 'failed', 'rejected', 'expired', 'invalidated'];
  v_ok boolean;
  -- D-19 / T-286: the composed content of the action: an email's bodyText, a Teams message's text.
  v_content_key text := case when new.action_type like 'teams.%' then 'text' else 'bodyText' end;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' or new.approved_by is not null or new.approved_at is not null or new.approved_hash is not null
       or new.executing_at is not null or new.executed_at is not null or new.verified_at is not null or new.payload_purged_at is not null then
      raise exception 'act: a new action must be proposed' using errcode = '23514';
    end if;
    if not exists (select 1 from core.connections c where c.id = new.connection_id and c.lane_id = new.lane_id and c.provider = new.provider) then
      raise exception 'act: the connection does not belong to this lane and provider' using errcode = '23503';
    end if;
    return new;
  end if;

  -- Identity and content never change. The one exception is the D-19 purge shape: the content key removed, nothing else.
  if new.id <> old.id or new.lane_id <> old.lane_id or new.action_type <> old.action_type or new.connection_id <> old.connection_id
     or new.provider <> old.provider or new.target <> old.target or new.payload_schema_version <> old.payload_schema_version
     or new.payload_sha256 <> old.payload_sha256 or new.proposer_kind <> old.proposer_kind
     or new.proposer_user_id is distinct from old.proposer_user_id or new.supersedes_id is distinct from old.supersedes_id
     or new.derived_from_retrieved <> old.derived_from_retrieved or new.expires_at <> old.expires_at or new.created_at <> old.created_at then
    raise exception 'act: the action''s identity and hash are immutable' using errcode = '42501';
  end if;

  -- A frozen (terminal) row may only be purged (and linked to the action that superseded it).
  if old.status = any (v_terminal) then
    if new.status <> old.status
       or (pg_catalog.to_jsonb(new) - array['payload', 'rationale', 'source_refs', 'payload_purged_at', 'superseded_by_id', 'updated_at'])
          is distinct from (pg_catalog.to_jsonb(old) - array['payload', 'rationale', 'source_refs', 'payload_purged_at', 'superseded_by_id', 'updated_at']) then
      raise exception 'act: % is a terminal state', old.status using errcode = '42501';
    end if;
  end if;

  if new.status <> old.status then
    v_ok := (old.status, new.status) in (
      ('proposed', 'approved'), ('proposed', 'rejected'), ('proposed', 'invalidated'), ('proposed', 'expired'),
      ('approved', 'executing'), ('approved', 'expired'), ('approved', 'invalidated'),
      ('executing', 'verified'), ('executing', 'failed'));
    if not v_ok then
      raise exception 'act: illegal transition % -> %', old.status, new.status using errcode = '42501';
    end if;
    if new.status = 'approved' and (new.approved_by is null or new.approved_at is null or new.approved_hash is distinct from new.payload_sha256) then
      raise exception 'act: approval must record the approver and the exact hash' using errcode = '42501';
    end if;
    if new.status = 'executing' and (old.approved_hash is distinct from old.payload_sha256) then
      raise exception 'act: the approved hash does not match the stored payload' using errcode = '42501';
    end if;
    -- D-19: any terminal state removes the composed content in the same statement.
    if new.status = any (v_terminal) and (new.action_type like 'email.%' or new.action_type like 'teams.%') and new.payload_purged_at is null then
      new.payload := new.payload - v_content_key;
      new.rationale := null;
      new.source_refs := '[]'::jsonb;
      new.payload_purged_at := pg_catalog.now();
    end if;
  elsif old.status <> 'proposed' and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
        or new.approved_hash is distinct from old.approved_hash) then
    raise exception 'act: the approval record is immutable' using errcode = '42501';
  end if;

  -- Payload: unchanged, or exactly the purge shape.
  if new.payload is distinct from old.payload then
    if not (new.payload_purged_at is not null and old.payload_purged_at is null and new.payload = old.payload - v_content_key) then
      raise exception 'act: the payload is immutable' using errcode = '42501';
    end if;
  end if;
  if old.payload_purged_at is not null and new.payload_purged_at is distinct from old.payload_purged_at then
    raise exception 'act: the purge time is immutable' using errcode = '42501';
  end if;
  if new.superseded_by_id is distinct from old.superseded_by_id and old.superseded_by_id is not null then
    raise exception 'act: superseded_by_id is set once' using errcode = '42501';
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function act.proposed_actions_guard() from public, anon, authenticated;

-- One send per composed message: the same client request id on the same connection is the same action.
create unique index proposed_actions_teams_request_uidx on act.proposed_actions (connection_id, (target ->> 'client_request_id'))
  where action_type like 'teams.%';

-- ---------------------------------------------------------------- visibility: a Teams action only to the owner of its connection
create or replace function act.action_rows_visible(p_action uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from act.proposed_actions a
    where a.id = p_action
      and case
            when act.is_email_type(a.action_type) then
              a.lane_id = any (core.allowed_lanes((select auth.uid()), 'own_mail'))
              and a.connection_id = any (core.mailbox_ids((select auth.uid()), null))
            when act.is_teams_type(a.action_type) then
              a.lane_id = any (core.allowed_lanes((select auth.uid()), 'own_mail'))
              and a.connection_id = any (core.teams_connection_ids((select auth.uid()), null))
            else a.lane_id = any (core.allowed_lanes((select auth.uid()), 'approvals'))
          end);
$$;
comment on function act.action_rows_visible(uuid) is 'T-247, T-286: may the caller read the status history / execution claim of this action: an email action only as its mailbox''s owner, a Teams action only as its connection''s owner, others through the approvals view.';
revoke all on function act.action_rows_visible(uuid) from public, anon;
grant execute on function act.action_rows_visible(uuid) to authenticated;

drop policy if exists proposed_actions_select on act.proposed_actions;
create policy proposed_actions_select on act.proposed_actions
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      -- email: only the owner of the mailbox the action sends from (an owner role or a proposer clause grants nothing here)
      (act.is_email_type(action_type)
        and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[])
        and connection_id = any ((select core.mailbox_ids((select auth.uid()), null))::uuid[]))
      -- Teams: only the owner of the Teams connection the message is sent from (an admin sees nothing of another person's Teams actions)
      or (act.is_teams_type(action_type)
        and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[])
        and connection_id = any ((select core.teams_connection_ids((select auth.uid()), null))::uuid[]))
      or (not act.is_email_type(action_type) and not act.is_teams_type(action_type) and (
        lane_id = any ((select core.allowed_lanes((select auth.uid()), 'approvals'))::text[])
        or (proposer_user_id = (select auth.uid())
            and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'lanes'))::text[]))
        or (action_type = 'qbo.disconnect'
            and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'connections'))::text[]))
      ))
    )
  );

-- ---------------------------------------------------------------- propose (shared by propose and supersede)
create or replace function act.insert_proposal(
  p_lane text, p_type text, p_connection uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text,
  p_rationale text, p_source_refs jsonb, p_proposer_kind text, p_proposer_user uuid, p_derived boolean, p_supersedes uuid
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_provider text;
  v_account text;
  v_owner uuid;
  v_status text;
  v_id uuid;
  v_dup uuid;
  v_dup_hash text;
begin
  if p_lane is null or p_type is null or p_connection is null or p_target is null or p_payload is null or p_hash is null then
    raise exception 'act: lane, type, connection, target, payload and hash are required' using errcode = '22004';
  end if;
  if not act.is_allowed_type(p_type) or act.is_denied_type(p_type) then
    raise exception 'act: this action type is not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'act: the lane is not enabled' using errcode = '42501';
  end if;
  -- D-19: an email proposal stores the composed body, and a Teams proposal the composed text, which the lane must have allowed.
  if (p_type like 'email.%' or act.is_teams_type(p_type)) and not exists (select 1 from core.lane_policies lp where lp.lane_id = p_lane and lp.store_outbound_drafts) then
    raise exception 'act: this lane does not allow storing outbound drafts' using errcode = '42501';
  end if;
  select c.provider, c.external_account_id, c.owner_user_id, c.status into v_provider, v_account, v_owner, v_status from core.connections c
  where c.id = p_connection and c.lane_id = p_lane and c.status <> 'disconnected';
  if v_provider is null then
    raise exception 'act: the connection does not belong to this lane or is disconnected' using errcode = '23503';
  end if;
  if p_type = 'qbo.disconnect' then
    -- A person's proposal only, for a QuickBooks connection, with exactly the realm as target and nothing in the payload.
    if p_proposer_kind <> 'user' or p_proposer_user is null or not core.has_lane_role(p_proposer_user, p_lane, act.write_roles(p_type)) then
      raise exception 'act: the owner or admin_technical role is required to propose this' using errcode = '42501';
    end if;
    if v_provider <> 'quickbooks' or p_target is distinct from pg_catalog.jsonb_build_object('realm_id', v_account) or p_payload <> '{}'::jsonb then
      raise exception 'act: the target or payload is not valid for this action' using errcode = '22023';
    end if;
  elsif act.is_teams_type(p_type) then
    -- T-286: a person's own message from their own Teams connection (never a job, never an edit of an earlier action): the composer's Send is the only way in.
    if v_provider <> 'microsoft_teams' then
      raise exception 'act: the connection does not belong to this lane and provider' using errcode = '23503';
    end if;
    if p_proposer_kind <> 'user' or p_proposer_user is null or p_supersedes is not null
       or v_owner is null or p_proposer_user is distinct from v_owner
       or not exists (select 1 from core.memberships m join core.lanes l on l.code = m.lane_id
                      where m.user_id = v_owner and m.lane_id = p_lane and l.enabled and 'own_mail' = any (core.role_views(m.role) || m.views)
                        and m.role = any (act.write_roles(p_type))) then
      raise exception 'act: a Teams message must be proposed by the owner of the Teams connection' using errcode = '42501';
    end if;
    if not act.teams_shape_ok(p_type, p_target, p_payload) then
      raise exception 'act: the target or payload is not valid for this action' using errcode = '22023';
    end if;
    -- The same gates as approve and claim, so no text is stored for a send that could never be approved.
    if coalesce(act.lane_setting(p_lane, 'approvals_live'), 'false') <> 'true' then
      raise exception 'act: not_live' using errcode = 'P0001';
    end if;
    if not act.type_allowed(p_lane, p_type) then
      raise exception 'act: type_not_allowed' using errcode = 'P0001';
    end if;
    if v_status not in ('active', 'degraded') or not act.teams_connection_ok(p_lane, p_connection, p_type) then
      raise exception 'act: connection_not_enabled' using errcode = 'P0001';
    end if;
  elsif v_provider not in ('google', 'microsoft') then
    raise exception 'act: the connection does not belong to this lane and provider' using errcode = '23503';
  end if;
  -- T-247: an email proposal is made for the mailbox owner (a job names them as proposer_user_id): nobody else's mailbox, and the owner must still hold own_mail here.
  -- (membership read directly, not through core.allowed_lanes: this function is security invoker and reached only by service_role code (through act.propose / supersede), and the check
  -- must not depend on the caller's role setting)
  if p_type like 'email.%' and (v_owner is null or p_proposer_user is distinct from v_owner
       or not exists (select 1 from core.memberships m join core.lanes l on l.code = m.lane_id
                      where m.user_id = v_owner and m.lane_id = p_lane and l.enabled and 'own_mail' = any (core.role_views(m.role) || m.views)
                        -- ... and holds the role that may approve this type (no undecidable draft is stored, e.g. none for a viewer)
                        and m.role = any (act.write_roles(p_type)))) then
    raise exception 'act: an email proposal must be made for the mailbox owner' using errcode = '42501';
  end if;
  -- One proposal writer per lane at a time: the cap and the duplicate check below cannot race (T-232 review M2, T-231d).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('act.insert_proposal:' || p_lane));
  -- T-286: one send per composed message. The same client request id on this connection is the same action: a double click or a network retry gets the existing action back
  -- (its status says what happened); the same id with different content is refused.
  if act.is_teams_type(p_type) then
    select a.id, a.payload_sha256 into v_dup, v_dup_hash from act.proposed_actions a
    where a.connection_id = p_connection and a.action_type like 'teams.%' and a.target ->> 'client_request_id' = p_target ->> 'client_request_id';
    if v_dup is not null then
      if v_dup_hash = p_hash then
        return v_dup;
      end if;
      raise exception 'act: client_request_id_reused' using errcode = '23505';
    end if;
  end if;
  -- The cap counts only unexpired proposals (expiry is lazy: an expired row still says 'proposed' until act.expire_stale).
  -- T-247 review: per mailbox owner for email (one user cannot fill the other's slots); other types stay lane-wide among themselves.
  -- T-286: Teams actions are counted per person among themselves, and no longer fill the slots of the other non-email types.
  if (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.expires_at > pg_catalog.now()
        and (a.action_type like 'email.%') = (p_type like 'email.%') and (p_type not like 'email.%' or a.proposer_user_id = p_proposer_user)
        and (a.action_type like 'teams.%') = (p_type like 'teams.%') and (p_type not like 'teams.%' or a.proposer_user_id = p_proposer_user)
        and a.id is distinct from p_supersedes) >= 20 then
    raise exception 'act: too many pending proposals in this lane' using errcode = '54000';
  end if;
  if p_type = 'qbo.disconnect' and exists (
       select 1 from act.proposed_actions a
       where a.lane_id = p_lane and a.connection_id = p_connection and a.action_type = 'qbo.disconnect'
         and ((a.status = 'proposed' and a.expires_at > pg_catalog.now()) or a.status in ('approved', 'executing'))) then
    raise exception 'act: disconnect_already_pending' using errcode = '23505';
  end if;
  -- T-231d: jobs (the daily briefing) have their own, smaller cap, so mail that lands in "attention" can never fill the
  -- lane's slots and lock the owner's own proposals out (T-231d security review M4).
  if p_proposer_kind = 'job' and p_supersedes is null
     and (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.proposer_kind = 'job'
            and (a.action_type like 'email.%') = (p_type like 'email.%') and (p_type not like 'email.%' or a.proposer_user_id = p_proposer_user)
            and a.expires_at > pg_catalog.now()) >= 6 then
    raise exception 'act: too many pending proposals in this lane (prepared replies)' using errcode = '54000';
  end if;
  -- T-231d: a job proposes at most one reply per message replied to: never while one is pending, approved, being sent
  -- or sent, and not again for 7 days after the owner rejected one (T-231d security review L1). A user's own proposals
  -- and edits (supersede) are not limited by this.
  if p_proposer_kind = 'job' and p_supersedes is null and p_payload -> 'inReplyTo' ->> 'messageId' is not null
     and exists (select 1 from act.proposed_actions a
                 where a.lane_id = p_lane and a.connection_id = p_connection
                   and a.payload -> 'inReplyTo' ->> 'messageId' = p_payload -> 'inReplyTo' ->> 'messageId'
                   and ((a.status = 'proposed' and a.expires_at > pg_catalog.now())
                        or a.status in ('approved', 'executing', 'verified')
                        or (a.status = 'failed' and act.is_unknown_failure(a.failure_code) and a.updated_at > pg_catalog.now() - interval '24 hours')
                        or (a.status = 'rejected' and a.updated_at > pg_catalog.now() - interval '7 days'))) then
    raise exception 'act: a reply to this message is already waiting for approval' using errcode = '23505';
  end if;
  -- T-234 part 3: the owner has one pending reply per message. A second proposal (two tabs, a double click) is refused; the app
  -- loads and edits the pending one. An edit (supersede) passes p_supersedes and is not affected.
  if p_proposer_kind = 'user' and p_supersedes is null and p_payload -> 'inReplyTo' ->> 'messageId' is not null
     and exists (select 1 from act.proposed_actions a
                 where a.lane_id = p_lane and a.connection_id = p_connection and a.status = 'proposed' and a.expires_at > pg_catalog.now()
                   and a.payload -> 'inReplyTo' ->> 'messageId' = p_payload -> 'inReplyTo' ->> 'messageId') then
    raise exception 'act: reply_already_pending' using errcode = '23505';
  end if;
  insert into act.proposed_actions (lane_id, action_type, connection_id, provider, target, payload, payload_schema_version, payload_sha256,
                                    rationale, source_refs, proposer_kind, proposer_user_id, derived_from_retrieved, supersedes_id, expires_at)
  values (p_lane, p_type, p_connection, v_provider, p_target, p_payload, p_version, p_hash,
          p_rationale, coalesce(p_source_refs, '[]'::jsonb), p_proposer_kind, p_proposer_user, coalesce(p_derived, false), p_supersedes,
          pg_catalog.now() + pg_catalog.make_interval(hours => act.expiry_hours(p_lane, p_type)))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function act.insert_proposal(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- approve
create or replace function act.approve(p_lane text, p_id uuid, p_hash_seen text) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row act.proposed_actions%rowtype;
  v_type text;
  v_max integer;
  v_raw text;
begin
  if v_uid is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'act: a signed-in session at aal2 is required' using errcode = '42501';
  end if;
  -- Any role that may approve something here; the role for this action's own type is checked once the row is loaded.
  if p_lane is null or p_id is null or p_hash_seen is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  -- T-286: the step-up window depends on the action's type, so the type is read first (no row is revealed: an unknown id gets the standard window and then not_found as before).
  select a.action_type into v_type from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane;
  if act.is_teams_type(v_type) then
    -- D-67 (open): approvals.teams_step_up_max_age_s, 300 to 43,200 seconds, default 300 (the same as email) until the owner decides.
    v_raw := act.lane_setting(p_lane, 'teams_step_up_max_age_s');
    v_max := case when v_raw ~ '^[0-9]{1,5}$' then least(greatest(v_raw::integer, 300), 43200) else 300 end;
  else
    -- Bounded here too (security review L1): a bad or huge lane setting never widens the TOTP window; 30..900 s, default 300.
    v_raw := act.lane_setting(p_lane, 'step_up_max_age_s');
    v_max := case when v_raw ~ '^[0-9]{1,4}$' then least(greatest(v_raw::integer, 30), 900) else 300 end;
  end if;
  if not act.step_up_ok(v_max) then
    raise exception 'act: step_up_required' using errcode = '42501';
  end if;
  -- T-195 review I1: the role for the action's own type is part of the lookup, so a member whose role does not cover this type
  -- (admin_technical and an email id) gets the same not_found as for an id that does not exist and cannot probe ids.
  -- T-286: a Teams action is found only by the owner of its connection (another person, an admin included, gets the same not_found).
  select a.* into v_row from act.proposed_actions a
  where a.id = p_id and a.lane_id = p_lane and core.has_lane_role(v_uid, p_lane, act.write_roles(a.action_type))
    and (not act.is_email_type(a.action_type) or a.connection_id = any (core.mailbox_ids(v_uid, p_lane)))
    and (not act.is_teams_type(a.action_type) or a.connection_id = any (core.teams_connection_ids(v_uid, p_lane))) for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'approved' then
    raise exception 'act: already_approved' using errcode = 'P0001';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'act: not_pending' using errcode = 'P0001';
  end if;
  if v_row.expires_at <= pg_catalog.now() then
    raise exception 'act: expired' using errcode = 'P0001';
  end if;
  if v_row.payload_purged_at is not null or p_hash_seen <> v_row.payload_sha256 then
    raise exception 'act: hash_mismatch' using errcode = 'P0001';
  end if;
  if coalesce(act.lane_setting(p_lane, 'approvals_live'), 'false') <> 'true' then
    raise exception 'act: not_live' using errcode = 'P0001';
  end if;
  if not act.type_allowed(p_lane, v_row.action_type) then
    raise exception 'act: type_not_allowed' using errcode = 'P0001';
  end if;
  if not act.connection_ok(p_lane, v_row) then
    raise exception 'act: connection_not_enabled' using errcode = 'P0001';
  end if;
  -- T-234 part 3: never approve a second email into a conversation while an earlier one is approved, being sent, or ended in a
  -- state where it may have gone out (unknown outcome, 24 h). The check and the status change run under one lock per thread.
  if v_row.payload -> 'inReplyTo' ->> 'threadId' is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('act.approve:' || p_lane || ':' || v_row.connection_id::text || ':' || (v_row.payload -> 'inReplyTo' ->> 'threadId')));
    if exists (select 1 from act.proposed_actions a
               where a.lane_id = p_lane and a.connection_id = v_row.connection_id and a.id <> v_row.id
                 and a.payload -> 'inReplyTo' ->> 'threadId' = v_row.payload -> 'inReplyTo' ->> 'threadId'
                 and (a.status in ('approved', 'executing')
                      or (a.status = 'failed' and act.is_unknown_failure(a.failure_code) and a.updated_at > pg_catalog.now() - interval '24 hours'))) then
      raise exception 'act: check_sent_first' using errcode = 'P0001';
    end if;
    -- T-234 part 3 re-check M1: a draft made BEFORE the latest reply in this conversation went out is stale.
    if exists (select 1 from act.proposed_actions a
               where a.lane_id = p_lane and a.connection_id = v_row.connection_id and a.id <> v_row.id
                 and a.action_type = 'email.send' and a.status = 'verified' and a.verified_at > v_row.created_at
                 and a.payload -> 'inReplyTo' ->> 'threadId' = v_row.payload -> 'inReplyTo' ->> 'threadId') then
      raise exception 'act: already_replied' using errcode = 'P0001';
    end if;
  end if;
  perform set_config('act.reason', 'approved', true);
  update act.proposed_actions
  set status = 'approved', approved_by = v_uid, approved_at = pg_catalog.now(), approved_hash = v_row.payload_sha256
  where id = v_row.id;
  return v_row.payload_sha256;
end;
$$;
comment on function act.approve(text, uuid, text) is
  'Approves the exact payload: aal2, TOTP step-up within step_up_max_age_s (teams_step_up_max_age_s for teams.*; amr), a role that may approve this type (act.write_roles: owner; owner or admin_technical for qbo.disconnect, email.* and teams.*), hash seen = stored hash, not expired, approvals_live, type allowed by lane policy, connection usable for the type (act.connection_ok), and for email no other approved/executing/failed-unknown action in the same thread and not made before the latest verified reply. An email is found only by its mailbox''s owner and a Teams action only by its connection''s owner.';
revoke all on function act.approve(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.approve(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- reject
create or replace function act.reject(p_lane text, p_id uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row act.proposed_actions%rowtype;
begin
  if v_uid is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'act: a signed-in session at aal2 is required' using errcode = '42501';
  end if;
  if p_lane is null or p_id is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  if p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason)) not between 1 and 500 then
    raise exception 'act: a reason of 1 to 500 characters is required' using errcode = '22023';
  end if;
  -- T-195 review I1: the role for the action's own type is part of the lookup, so a member whose role does not cover this type
  -- (admin_technical and an email id) gets the same not_found as for an id that does not exist and cannot probe ids.
  -- T-286: a Teams action is found only by the owner of its connection.
  select a.* into v_row from act.proposed_actions a
  where a.id = p_id and a.lane_id = p_lane and core.has_lane_role(v_uid, p_lane, act.write_roles(a.action_type))
    and (not act.is_email_type(a.action_type) or a.connection_id = any (core.mailbox_ids(v_uid, p_lane)))
    and (not act.is_teams_type(a.action_type) or a.connection_id = any (core.teams_connection_ids(v_uid, p_lane))) for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'proposed' then
    raise exception 'act: not_pending' using errcode = 'P0001';
  end if;
  perform set_config('act.reason', pg_catalog.btrim(p_reason), true);
  update act.proposed_actions set status = 'rejected' where id = v_row.id;
end;
$$;
comment on function act.reject(text, uuid, text) is 'Rejects a pending proposal (aal2, a role that may approve its type, reason required); an email body or a Teams text is purged (D-19). An email or Teams action is found only by the owner of its connection.';
revoke all on function act.reject(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.reject(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- claim
create or replace function act.claim_execution(p_lane text, p_id uuid) returns act.proposed_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row act.proposed_actions%rowtype;
begin
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'approved' then
    raise exception 'act: not_approved' using errcode = 'P0001';
  end if;
  if v_row.approved_hash is distinct from v_row.payload_sha256 then
    raise exception 'act: hash_mismatch' using errcode = 'P0001';
  end if;
  if v_row.expires_at <= pg_catalog.now() then
    raise exception 'act: expired' using errcode = 'P0001';
  end if;
  if coalesce(act.lane_setting(p_lane, 'approvals_live'), 'false') <> 'true' then
    raise exception 'act: not_live' using errcode = 'P0001';
  end if;
  if not act.type_allowed(p_lane, v_row.action_type) then
    raise exception 'act: type_not_allowed' using errcode = 'P0001';
  end if;
  if not core.has_lane_role(v_row.approved_by, p_lane, act.write_roles(v_row.action_type)) then
    raise exception 'act: approver_revoked' using errcode = 'P0001';
  end if;
  if (act.is_email_type(v_row.action_type) or act.is_teams_type(v_row.action_type))
     and not exists (select 1 from core.connections c where c.id = v_row.connection_id and c.lane_id = p_lane and c.owner_user_id = v_row.approved_by) then
    raise exception 'act: approver_revoked' using errcode = 'P0001';
  end if;
  -- T-286: a Teams message is sent only while its text is still held (a purged action is never executed).
  if act.is_teams_type(v_row.action_type) and v_row.payload_purged_at is not null then
    raise exception 'act: hash_mismatch' using errcode = 'P0001';
  end if;
  if not act.connection_ok(p_lane, v_row) then
    raise exception 'act: connection_not_enabled' using errcode = 'P0001';
  end if;
  begin
    insert into act.execution_claims (action_id, lane_id, idempotency_key) values (v_row.id, p_lane, v_row.id);
  exception when unique_violation then
    raise exception 'act: already_claimed' using errcode = 'P0001';
  end;
  perform set_config('act.reason', 'execution claimed', true);
  update act.proposed_actions set status = 'executing', executing_at = pg_catalog.now() where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;
comment on function act.claim_execution(text, uuid) is
  'approved -> executing with the single execution claim (service_role only). Re-checks hash, expiry, approvals_live, lane policy, approver role for the type, that an email or Teams action''s approver still owns the connection, and the connection.';
revoke all on function act.claim_execution(text, uuid) from public, anon, authenticated, service_role;
grant execute on function act.claim_execution(text, uuid) to service_role;

-- ---------------------------------------------------------------- disconnect: the open Teams actions of a removed connection
-- Called by the Teams disconnect (a purger, service_role). Open actions (proposed, approved) become invalidated with their text purged (the guard); an action that is executing may already
-- have been sent, so it ends failed / connection_disconnected with an unknown outcome (its text is purged too; a person checks the chat). Returns the number of actions closed. Lane-checked.
create or replace function core.teams_actions_purge_connection(p_lane text, p_connection uuid) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open integer;
  v_exec integer;
begin
  if p_lane is null or p_connection is null then
    raise exception 'teams actions purge: lane and connection are required' using errcode = '22004';
  end if;
  perform set_config('act.reason', 'the Teams connection was disconnected', true);
  update act.proposed_actions set status = 'invalidated'
  where lane_id = p_lane and connection_id = p_connection and action_type like 'teams.%' and status in ('proposed', 'approved');
  get diagnostics v_open = row_count;
  with ended as (
    update act.proposed_actions set status = 'failed', failure_code = 'connection_disconnected'
    where lane_id = p_lane and connection_id = p_connection and action_type like 'teams.%' and status = 'executing'
    returning id
  )
  update act.execution_claims c set outcome = case when c.outcome = 'sent' then 'sent' else 'outcome_unknown' end, finished_at = pg_catalog.now()
  from ended where c.action_id = ended.id and c.lane_id = p_lane;
  get diagnostics v_exec = row_count;
  return v_open + v_exec;
end;
$$;
comment on function core.teams_actions_purge_connection(text, uuid) is 'T-286: closes the open teams.* actions of a disconnected Teams connection (text purged); an executing one ends failed / connection_disconnected. service_role only.';
revoke all on function core.teams_actions_purge_connection(text, uuid) from public, anon, authenticated;
grant execute on function core.teams_actions_purge_connection(text, uuid) to service_role;
