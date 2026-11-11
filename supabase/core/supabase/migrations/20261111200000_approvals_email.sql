-- T-232: the Approval Center for email (docs/specs/approvals.md §4-§8, email-only subset: email.send and
-- email.save_draft). Schema `act`: proposals, their status history and the single execution claim per action.
-- `act` is NOT a PostgREST-exposed schema; the app reaches it through the thin SECURITY INVOKER wrappers `core.act_*`
-- (core is exposed), exactly as Brain does (T-210).
--
-- Access
--   * Reads (RLS, AAL2): the owner of the lane (view 'approvals') sees every action; a proposer sees their own (a member
--     of the lane with proposer_user_id = auth.uid()); nobody else. status_history and execution_claims: owner only.
--   * Writes: NO user DML and no service_role DML. Every change is one of the reviewed functions below.
--       act.propose / act.supersede                          service_role only (the app computes the JCS hash in TypeScript)
--       act.approve / act.reject                             authenticated: AAL2, TOTP step-up (amr), owner role, hash seen
--       act.claim_execution / claim_sent / mark_verified / mark_failed / expire_stale     service_role only
--   * State machine and immutability are enforced by a trigger, not by the callers: payload, target, hash, connection and
--     type never change (the only exception is the D-19 body purge); every illegal transition raises.
--   * D-19: entering ANY terminal state (verified, failed, rejected, expired, invalidated) removes payload.bodyText (and
--     the rationale and source refs) in the same statement, so no terminal email action keeps a body. Recipients,
--     subject, hash, timestamps and history stay.
--   * Two gates re-checked at approve AND at claim: lane_config.approvals.approvals_live, the type in
--     lane_policies.write_actions_allowed (email_send / email_draft), and the connection's features.gmail_compose.
-- Not in this subset (spec §4, recorded in the PR): defer, expected_before/consequences columns, core.action_index,
-- invalidate_approved, retention purge for non-email types (no other type exists yet).

create schema act;
revoke all on schema act from public, anon;
grant usage on schema act to authenticated, service_role;
alter default privileges in schema act revoke execute on functions from public;

-- ---------------------------------------------------------------- pure helpers
create function act.is_allowed_type(p_type text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type in ('email.send', 'email.save_draft');
$$;

-- Excluded classes (spec §2): never allowed even if the list above were widened by mistake.
create function act.is_denied_type(p_type text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type is null or pg_catalog.lower(p_type) ~ '(payment|transfer|disbursement|qbo_post|quickbooks|stripe|gohighlevel|delete|permission|remove|purge)';
$$;

-- True when the caller's token has a TOTP verification within p_max_age seconds (amr timestamps; 30 s clock skew).
create function act.step_up_ok(p_max_age integer) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.jsonb_array_elements(
           case when pg_catalog.jsonb_typeof((select auth.jwt()) -> 'amr') = 'array' then (select auth.jwt()) -> 'amr' else '[]'::jsonb end) e
    where e ->> 'method' in ('totp', 'mfa/totp')
      and pg_catalog.jsonb_typeof(e -> 'timestamp') = 'number'
      and (e ->> 'timestamp')::numeric between pg_catalog.date_part('epoch', pg_catalog.now()) - p_max_age
                                           and pg_catalog.date_part('epoch', pg_catalog.now()) + 30
  );
$$;

-- The lane's approvals settings with the defaults of laneConfigSchema (approvals_live false, owner, 300 s, 72 h).
create function act.lane_setting(p_lane text, p_key text) returns text
language sql
stable
set search_path = ''
as $$
  select c.config -> 'approvals' ->> p_key from core.lane_config_current c where c.lane_id = p_lane;
$$;

create function act.expiry_hours(p_lane text, p_type text) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when c.config -> 'approvals' -> 'expire_after_hours' ->> p_type ~ '^[0-9]{1,3}$'
                 then (c.config -> 'approvals' -> 'expire_after_hours' ->> p_type)::integer end
     from core.lane_config_current c where c.lane_id = p_lane),
    72);
$$;

-- The lane policy allows this type (email.send needs email_send, email.save_draft needs email_draft).
create function act.type_allowed(p_lane text, p_type text) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.lane_policies p
    where p.lane_id = p_lane
      and ((p_type = 'email.send' and 'email_send' = any (p.write_actions_allowed))
        or (p_type = 'email.save_draft' and 'email_draft' = any (p.write_actions_allowed)))
  );
$$;

revoke all on function act.is_allowed_type(text), act.is_denied_type(text), act.step_up_ok(integer), act.lane_setting(text, text),
  act.expiry_hours(text, text), act.type_allowed(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- act.proposed_actions
create table act.proposed_actions (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  action_type text not null check (act.is_allowed_type(action_type) and not act.is_denied_type(action_type)),
  connection_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  -- Non-secret descriptor: for email {mailbox, thread_id?}.
  target jsonb not null check (pg_catalog.jsonb_typeof(target) = 'object' and pg_catalog.octet_length(target::text) <= 2048 and not core.jsonb_has_secret(target)),
  -- The exact content to execute (email: fromMailbox, to, cc, bcc, subject, bodyText, inReplyTo?). Validated by the app's Zod schema.
  payload jsonb not null check (pg_catalog.jsonb_typeof(payload) = 'object' and pg_catalog.octet_length(payload::text) <= 200000),
  payload_schema_version integer not null check (payload_schema_version >= 1),
  -- SHA-256 of the JCS canonical JSON of {lane_id, action_type, connection_id, target, payload, payload_schema_version}, computed by the app.
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  rationale text check (pg_catalog.length(rationale) <= 2000),
  source_refs jsonb not null default '[]'::jsonb check (pg_catalog.jsonb_typeof(source_refs) = 'array' and pg_catalog.octet_length(source_refs::text) <= 8192),
  proposer_kind text not null check (proposer_kind in ('user', 'assistant', 'job')),
  -- Plain ids (no FK): a deleted user must not rewrite a frozen action; the audit trail keeps who.
  proposer_user_id uuid,
  -- True when recipients or content came from retrieved content (spec §9); the UI shows a banner.
  derived_from_retrieved boolean not null default false,
  supersedes_id uuid references act.proposed_actions (id) on update restrict on delete restrict,
  superseded_by_id uuid references act.proposed_actions (id) on update restrict on delete restrict,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'executing', 'verified', 'failed', 'rejected', 'expired', 'invalidated')),
  expires_at timestamptz not null,
  approved_by uuid,
  approved_at timestamptz,
  approved_hash text check (approved_hash ~ '^[0-9a-f]{64}$'),
  executing_at timestamptz,
  executed_at timestamptz,
  verified_at timestamptz,
  -- Ids and outcome only: never a body.
  result jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(result) = 'object' and pg_catalog.octet_length(result::text) <= 2048 and not core.jsonb_has_secret(result)),
  failure_code text check (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  payload_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict,
  unique (id, lane_id),
  check (supersedes_id is distinct from id and superseded_by_id is distinct from id),
  check (status not in ('approved', 'executing', 'verified') or (approved_at is not null and approved_hash is not null))
);
comment on table act.proposed_actions is
  'Proposed external writes (T-232, email only). Written only by the act.* functions; state machine and immutability by trigger.';
create index proposed_actions_lane_status_idx on act.proposed_actions (lane_id, status, created_at desc);
create index proposed_actions_connection_idx on act.proposed_actions (connection_id);
create index proposed_actions_proposer_idx on act.proposed_actions (proposer_user_id) where proposer_user_id is not null;

-- ---------------------------------------------------------------- act.status_history (insert-only)
create table act.status_history (
  id bigint generated always as identity primary key,
  action_id uuid not null,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  from_status text,
  to_status text not null,
  actor_kind text not null check (actor_kind in ('user', 'service', 'system')),
  actor_id uuid,
  at timestamptz not null default now(),
  reason text check (pg_catalog.length(reason) <= 500),
  foreign key (action_id, lane_id) references act.proposed_actions (id, lane_id) on update restrict on delete restrict
);
comment on table act.status_history is 'Insert-only status log of act.proposed_actions (T-232). Ids and states only.';
create index status_history_action_idx on act.status_history (action_id);
create index status_history_lane_id_idx on act.status_history (lane_id);

create function act.status_history_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'act.status_history is insert-only' using errcode = '42501';
end;
$$;
create trigger status_history_no_change before update or delete on act.status_history
  for each row execute function act.status_history_guard();

-- ---------------------------------------------------------------- act.execution_claims (one row per action)
create table act.execution_claims (
  action_id uuid primary key,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('sent', 'verified', 'mismatch', 'error', 'outcome_unknown')),
  external_id text check (pg_catalog.length(external_id) <= 256),
  -- = the action id; the provider-side marker is Message-ID <portal-{id}@domain> + X-Portal-Action-Id.
  idempotency_key uuid not null,
  foreign key (action_id, lane_id) references act.proposed_actions (id, lane_id) on update restrict on delete restrict,
  check (idempotency_key = action_id)
);
comment on table act.execution_claims is
  'Exactly one claim per action (primary key): a second claim violates it. Recovery after an unknown outcome is verify-only and never creates a claim.';
create index execution_claims_lane_id_idx on act.execution_claims (lane_id);

-- ---------------------------------------------------------------- state machine and immutability
create function act.proposed_actions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_terminal constant text[] := array['verified', 'failed', 'rejected', 'expired', 'invalidated'];
  v_ok boolean;
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

  -- Identity and content never change. The one exception is the D-19 purge shape: bodyText removed, nothing else.
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
    -- D-19: any terminal state removes the composed body in the same statement.
    if new.status = any (v_terminal) and new.action_type like 'email.%' and new.payload_purged_at is null then
      new.payload := new.payload - 'bodyText';
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
    if not (new.payload_purged_at is not null and old.payload_purged_at is null and new.payload = old.payload - 'bodyText') then
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
create trigger proposed_actions_guard before insert or update on act.proposed_actions
  for each row execute function act.proposed_actions_guard();

-- No deletes, ever (history and hash stay).
create function act.proposed_actions_no_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'act.proposed_actions rows are never deleted' using errcode = '42501';
end;
$$;
create trigger proposed_actions_no_delete before delete on act.proposed_actions
  for each row execute function act.proposed_actions_no_delete();

-- Status history, written by the same statement that changes the status.
create function act.proposed_actions_history() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return null;
  end if;
  insert into act.status_history (action_id, lane_id, from_status, to_status, actor_kind, actor_id, reason)
  values (new.id, new.lane_id, case when tg_op = 'UPDATE' then old.status end, new.status,
          case when v_uid is not null then 'user' when pg_catalog.current_setting('role', true) = 'service_role' then 'service' else 'system' end,
          v_uid, nullif(pg_catalog.current_setting('act.reason', true), ''));
  return null;
end;
$$;
create trigger proposed_actions_history after insert or update on act.proposed_actions
  for each row execute function act.proposed_actions_history();

revoke all on function act.proposed_actions_guard(), act.proposed_actions_no_delete(), act.proposed_actions_history(),
  act.status_history_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------- RLS
alter table act.proposed_actions enable row level security;
alter table act.status_history enable row level security;
alter table act.execution_claims enable row level security;

-- Owner (approvals view) sees the lane's actions; a proposer who is a member of the lane sees their own.
create policy proposed_actions_select on act.proposed_actions
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      lane_id = any ((select core.allowed_lanes((select auth.uid()), 'approvals'))::text[])
      or (proposer_user_id = (select auth.uid())
          and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'lanes'))::text[]))
    )
  );
create policy status_history_select on act.status_history
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'approvals'))::text[])
  );
create policy execution_claims_select on act.execution_claims
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'approvals'))::text[])
  );

revoke all on all tables in schema act from public, anon, authenticated, service_role;
grant select on act.proposed_actions, act.status_history, act.execution_claims to authenticated;

-- ---------------------------------------------------------------- writers (security definer, reviewed)

-- Shared by propose and supersede. Not callable by API roles.
create function act.insert_proposal(
  p_lane text, p_type text, p_connection uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text,
  p_rationale text, p_source_refs jsonb, p_proposer_kind text, p_proposer_user uuid, p_derived boolean, p_supersedes uuid
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_provider text;
  v_id uuid;
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
  -- D-19: an email proposal stores the composed body, which the lane must have allowed.
  if p_type like 'email.%' and not exists (select 1 from core.lane_policies lp where lp.lane_id = p_lane and lp.store_outbound_drafts) then
    raise exception 'act: this lane does not allow storing outbound drafts' using errcode = '42501';
  end if;
  select c.provider into v_provider from core.connections c
  where c.id = p_connection and c.lane_id = p_lane and c.status <> 'disconnected';
  if v_provider is null then
    raise exception 'act: the connection does not belong to this lane or is disconnected' using errcode = '23503';
  end if;
  -- One proposal writer per lane at a time: the cap and the duplicate check below cannot race (T-232 review M2, T-231d).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('act.insert_proposal:' || p_lane));
  -- The cap counts only unexpired proposals (expiry is lazy: an expired row still says 'proposed' until act.expire_stale).
  if (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.expires_at > pg_catalog.now()
        and a.id is distinct from p_supersedes) >= 20 then
    raise exception 'act: too many pending proposals in this lane' using errcode = '54000';
  end if;
  -- T-231d: a job (the daily briefing) proposes at most one pending reply per message replied to, so re-running the
  -- briefing never piles up copies. A user's own proposals and edits (supersede) are not limited by this.
  if p_proposer_kind = 'job' and p_supersedes is null and p_payload -> 'inReplyTo' ->> 'messageId' is not null
     and exists (select 1 from act.proposed_actions a
                 where a.lane_id = p_lane and a.connection_id = p_connection and a.status = 'proposed' and a.expires_at > pg_catalog.now()
                   and a.payload -> 'inReplyTo' ->> 'messageId' = p_payload -> 'inReplyTo' ->> 'messageId') then
    raise exception 'act: a reply to this message is already waiting for approval' using errcode = '23505';
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
revoke all on function act.insert_proposal(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean, uuid)
  from public, anon, authenticated;

create function act.propose(
  p_lane text, p_type text, p_connection uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text,
  p_rationale text, p_source_refs jsonb, p_proposer_kind text, p_proposer_user uuid, p_derived boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('act.reason', 'proposed', true);
  return act.insert_proposal(p_lane, p_type, p_connection, p_target, p_payload, p_version, p_hash, p_rationale, p_source_refs,
                             p_proposer_kind, p_proposer_user, p_derived, null);
end;
$$;
comment on function act.propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean) is
  'Creates a proposal (service_role only; the app supplies the JCS hash). Refuses email.* unless lane_policies.store_outbound_drafts (D-19), a connection of another lane, more than 20 pending, and any non-email type.';

-- An edit is a new proposal; the old one becomes invalidated (its body is purged) and points at the new one.
create function act.supersede(
  p_lane text, p_old uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text, p_rationale text, p_source_refs jsonb,
  p_proposer_user uuid, p_derived boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old act.proposed_actions%rowtype;
  v_new uuid;
begin
  select a.* into v_old from act.proposed_actions a where a.id = p_old and a.lane_id = p_lane for update;
  if not found then
    raise exception 'act: not_found' using errcode = 'P0002';
  end if;
  -- Only a pending proposal can be edited (security review L2): an edit never withdraws an approval in flight.
  if v_old.status <> 'proposed' then
    raise exception 'act: not_editable' using errcode = 'P0001';
  end if;
  perform set_config('act.reason', 'edited', true);
  v_new := act.insert_proposal(p_lane, v_old.action_type, v_old.connection_id, p_target, p_payload, p_version, p_hash, p_rationale,
                               p_source_refs, 'user', p_proposer_user, p_derived, v_old.id);
  update act.proposed_actions set status = 'invalidated', superseded_by_id = v_new where id = v_old.id;
  return v_new;
end;
$$;
comment on function act.supersede(text, uuid, jsonb, jsonb, integer, text, text, jsonb, uuid, boolean) is
  'Edit = new proposal superseding the old one, which becomes invalidated and loses its body (service_role only).';

-- Approve the exact payload. Every gate in one place; the app has already checked the same things for a clear message.
create function act.approve(p_lane text, p_id uuid, p_hash_seen text) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row act.proposed_actions%rowtype;
  v_max integer;
  v_raw text;
begin
  if v_uid is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'act: a signed-in session at aal2 is required' using errcode = '42501';
  end if;
  if p_lane is null or p_id is null or p_hash_seen is null or not core.has_lane_role(v_uid, p_lane, array['owner']) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  -- Bounded here too (security review L1): a bad or huge lane setting never widens the TOTP window; 30..900 s, default 300.
  v_raw := act.lane_setting(p_lane, 'step_up_max_age_s');
  v_max := case when v_raw ~ '^[0-9]{1,4}$' then least(greatest(v_raw::integer, 30), 900) else 300 end;
  if not act.step_up_ok(v_max) then
    raise exception 'act: step_up_required' using errcode = '42501';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
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
  if not exists (select 1 from core.connections c where c.id = v_row.connection_id and c.lane_id = p_lane and c.status in ('active', 'degraded')
                   and c.features ->> 'gmail_compose' = 'true') then
    raise exception 'act: connection_not_enabled' using errcode = 'P0001';
  end if;
  perform set_config('act.reason', 'approved', true);
  update act.proposed_actions
  set status = 'approved', approved_by = v_uid, approved_at = pg_catalog.now(), approved_hash = v_row.payload_sha256
  where id = v_row.id;
  return v_row.payload_sha256;
end;
$$;
comment on function act.approve(text, uuid, text) is
  'Approves the exact payload: aal2, TOTP step-up within step_up_max_age_s (amr), owner of the lane, hash seen = stored hash, not expired, approvals_live, type allowed by lane policy, connection granted compose.';

create function act.reject(p_lane text, p_id uuid, p_reason text) returns void
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
  if p_lane is null or p_id is null or not core.has_lane_role(v_uid, p_lane, array['owner']) then
    raise exception 'act: the owner role in this lane is required' using errcode = '42501';
  end if;
  if p_reason is null or pg_catalog.length(pg_catalog.btrim(p_reason)) not between 1 and 500 then
    raise exception 'act: a reason of 1 to 500 characters is required' using errcode = '22023';
  end if;
  select a.* into v_row from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane for update;
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
comment on function act.reject(text, uuid, text) is 'Rejects a pending proposal (aal2, owner of the lane, reason required); the body is purged (D-19).';

-- approved -> executing, with the single claim. Re-validates every gate; returns the stored row for the executor.
create function act.claim_execution(p_lane text, p_id uuid) returns act.proposed_actions
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
  if not core.has_lane_role(v_row.approved_by, p_lane, array['owner']) then
    raise exception 'act: approver_revoked' using errcode = 'P0001';
  end if;
  if not exists (select 1 from core.connections c where c.id = v_row.connection_id and c.lane_id = p_lane and c.status in ('active', 'degraded')
                   and c.features ->> 'gmail_compose' = 'true') then
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
  'approved -> executing with the single execution claim (service_role only). Re-checks hash, expiry, approvals_live, lane policy, approver role and the connection grant.';

-- Records the provider id right after the external write, before the read-back (crash recovery needs it).
create function act.claim_sent(p_lane text, p_id uuid, p_external_id text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update act.execution_claims set outcome = 'sent', external_id = p_external_id
  where action_id = p_id and lane_id = p_lane and outcome is null
    and exists (select 1 from act.proposed_actions a where a.id = p_id and a.lane_id = p_lane and a.status = 'executing');
  if not found then
    raise exception 'act: no open claim' using errcode = 'P0001';
  end if;
  update act.proposed_actions set executed_at = pg_catalog.now() where id = p_id and lane_id = p_lane and executed_at is null;
end;
$$;

create function act.mark_verified(p_lane text, p_id uuid, p_external_id text, p_outcome text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_outcome not in ('accepted', 'already_applied') then
    raise exception 'act: invalid outcome' using errcode = '22023';
  end if;
  perform set_config('act.reason', 'verified', true);
  update act.proposed_actions
  set status = 'verified', verified_at = pg_catalog.now(), executed_at = coalesce(executed_at, pg_catalog.now()),
      result = pg_catalog.jsonb_build_object('external_id', p_external_id, 'outcome', p_outcome)
  where id = p_id and lane_id = p_lane and status = 'executing';
  if not found then
    raise exception 'act: not_executing' using errcode = 'P0001';
  end if;
  update act.execution_claims set outcome = 'verified', finished_at = pg_catalog.now(), external_id = coalesce(p_external_id, external_id)
  where action_id = p_id and lane_id = p_lane;
end;
$$;

create function act.mark_failed(p_lane text, p_id uuid, p_code text, p_outcome text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_outcome not in ('mismatch', 'error', 'outcome_unknown') then
    raise exception 'act: invalid outcome' using errcode = '22023';
  end if;
  perform set_config('act.reason', 'failed: ' || coalesce(p_code, ''), true);
  update act.proposed_actions set status = 'failed', failure_code = p_code
  where id = p_id and lane_id = p_lane and status = 'executing';
  if not found then
    raise exception 'act: not_executing' using errcode = 'P0001';
  end if;
  update act.execution_claims set outcome = p_outcome, finished_at = pg_catalog.now()
  where action_id = p_id and lane_id = p_lane;
end;
$$;

-- Stale proposals (and approved-but-never-executed ones) past their expiry become expired; bodies purged by the trigger.
create function act.expire_stale(p_lane text) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform set_config('act.reason', 'expired', true);
  update act.proposed_actions set status = 'expired'
  where lane_id = p_lane and status in ('proposed', 'approved') and expires_at <= pg_catalog.now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function act.propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean),
  act.supersede(text, uuid, jsonb, jsonb, integer, text, text, jsonb, uuid, boolean),
  act.claim_execution(text, uuid), act.claim_sent(text, uuid, text), act.mark_verified(text, uuid, text, text),
  act.mark_failed(text, uuid, text, text), act.expire_stale(text),
  act.approve(text, uuid, text), act.reject(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean),
  act.supersede(text, uuid, jsonb, jsonb, integer, text, text, jsonb, uuid, boolean),
  act.claim_execution(text, uuid), act.claim_sent(text, uuid, text), act.mark_verified(text, uuid, text, text),
  act.mark_failed(text, uuid, text, text), act.expire_stale(text) to service_role;
grant execute on function act.approve(text, uuid, text), act.reject(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------- core.act_* wrappers (the exposed surface)
-- Writers: thin invoker wrappers, same arguments; the grants above decide who can run them.
create function core.act_propose(
  p_lane text, p_type text, p_connection uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text,
  p_rationale text, p_source_refs jsonb, p_proposer_kind text, p_proposer_user uuid, p_derived boolean
) returns uuid language sql security invoker set search_path = '' as $$
  select act.propose(p_lane, p_type, p_connection, p_target, p_payload, p_version, p_hash, p_rationale, p_source_refs, p_proposer_kind, p_proposer_user, p_derived);
$$;
create function core.act_supersede(
  p_lane text, p_old uuid, p_target jsonb, p_payload jsonb, p_version integer, p_hash text, p_rationale text, p_source_refs jsonb,
  p_proposer_user uuid, p_derived boolean
) returns uuid language sql security invoker set search_path = '' as $$
  select act.supersede(p_lane, p_old, p_target, p_payload, p_version, p_hash, p_rationale, p_source_refs, p_proposer_user, p_derived);
$$;
create function core.act_approve(p_lane text, p_id uuid, p_hash_seen text) returns text
language sql security invoker set search_path = '' as $$ select act.approve(p_lane, p_id, p_hash_seen); $$;
create function core.act_reject(p_lane text, p_id uuid, p_reason text) returns void
language sql security invoker set search_path = '' as $$ select act.reject(p_lane, p_id, p_reason); $$;
create function core.act_claim_execution(p_lane text, p_id uuid) returns act.proposed_actions
language sql security invoker set search_path = '' as $$ select * from act.claim_execution(p_lane, p_id); $$;
create function core.act_claim_sent(p_lane text, p_id uuid, p_external_id text) returns void
language sql security invoker set search_path = '' as $$ select act.claim_sent(p_lane, p_id, p_external_id); $$;
create function core.act_mark_verified(p_lane text, p_id uuid, p_external_id text, p_outcome text) returns void
language sql security invoker set search_path = '' as $$ select act.mark_verified(p_lane, p_id, p_external_id, p_outcome); $$;
create function core.act_mark_failed(p_lane text, p_id uuid, p_code text, p_outcome text) returns void
language sql security invoker set search_path = '' as $$ select act.mark_failed(p_lane, p_id, p_code, p_outcome); $$;
create function core.act_expire_stale(p_lane text) returns integer
language sql security invoker set search_path = '' as $$ select act.expire_stale(p_lane); $$;

-- Reads (invoker: RLS on act.proposed_actions applies). Newest first, at most p_limit (1 to 100) rows.
create function core.act_list(p_lane text, p_limit integer default 50) returns setof act.proposed_actions
language sql stable security invoker set search_path = '' as $$
  select a.* from act.proposed_actions a
  where a.lane_id = p_lane
  order by (a.status = 'proposed') desc, a.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;
create function core.act_get(p_lane text, p_id uuid) returns setof act.proposed_actions
language sql stable security invoker set search_path = '' as $$
  select a.* from act.proposed_actions a where a.lane_id = p_lane and a.id = p_id;
$$;
-- The Gmail writer's own check before any send (T-232 security review H1, defence in depth): the action is executing, its
-- claim is open (nothing sent yet), the hash given is the approved and stored hash, and the approver given is the one
-- recorded. A writer handed out by mistake still cannot send anything that was not approved and claimed here.
create function core.act_claim_open(p_lane text, p_id uuid, p_hash text, p_approver uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from act.proposed_actions a
    join act.execution_claims c on c.action_id = a.id and c.lane_id = a.lane_id
    where a.lane_id = p_lane and a.id = p_id and a.status = 'executing'
      and a.approved_hash = p_hash and a.payload_sha256 = p_hash and a.approved_by = p_approver
      and c.outcome is null);
$$;
comment on function core.act_claim_open(text, uuid, text, uuid) is 'Approvals (T-232): true only for an executing action with an open claim, the approved hash and the recorded approver. service_role only.';
revoke all on function core.act_claim_open(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function core.act_claim_open(text, uuid, text, uuid) to service_role;
-- Pending (proposed, unexpired) count for Home. Counts only what the caller may see.
create function core.act_pending_count(p_lane text) returns integer
language sql stable security invoker set search_path = '' as $$
  select count(*)::integer from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.expires_at > pg_catalog.now();
$$;

revoke all on function core.act_propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean),
  core.act_supersede(text, uuid, jsonb, jsonb, integer, text, text, jsonb, uuid, boolean),
  core.act_claim_execution(text, uuid), core.act_claim_sent(text, uuid, text), core.act_mark_verified(text, uuid, text, text),
  core.act_mark_failed(text, uuid, text, text), core.act_expire_stale(text),
  core.act_approve(text, uuid, text), core.act_reject(text, uuid, text),
  core.act_list(text, integer), core.act_get(text, uuid), core.act_pending_count(text) from public, anon, authenticated, service_role;
grant execute on function core.act_propose(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean),
  core.act_supersede(text, uuid, jsonb, jsonb, integer, text, text, jsonb, uuid, boolean),
  core.act_claim_execution(text, uuid), core.act_claim_sent(text, uuid, text), core.act_mark_verified(text, uuid, text, text),
  core.act_mark_failed(text, uuid, text, text), core.act_expire_stale(text) to service_role;
grant execute on function core.act_approve(text, uuid, text), core.act_reject(text, uuid, text),
  core.act_list(text, integer), core.act_get(text, uuid), core.act_pending_count(text) to authenticated;
