-- T-234 part 3 review fixes: duplicate-send guard for the reply drawer.
--   * act.is_unknown_failure(code): the failure codes after which an email MAY have gone out (one definition for all callers).
--   * core.act_reply_state(lane, connection, thread, message): what the drawer needs in one call (pending proposal for the message,
--     "blocked" for the thread, when a reply was last verified). Invoker: RLS applies, so another lane or AAL1 sees nothing.
--   * act.approve refuses (check_sent_first) a second email in a thread while one is approved, executing or failed-unknown (24 h).
--   * act.insert_proposal: a job also waits after a failed-unknown action (M2); an owner cannot open a second pending proposal for
--     the same message (reply_already_pending); an edit (supersede) is not affected.
-- Safe to re-run: create or replace only (signatures unchanged).

create or replace function act.is_unknown_failure(p_code text) returns boolean
language sql immutable set search_path = ''
as $$
  select p_code is not null
     and (p_code in ('outcome_unknown', 'marker_not_found', 'ambiguous_match')
          or p_code like 'verification\_%' or p_code like 'reconcile\_%');
$$;
comment on function act.is_unknown_failure(text) is 'True for a failure code after which the email may exist in the mailbox (outcome_unknown, verification_*, marker_not_found, ambiguous_match, reconcile_*) (T-234).';
revoke all on function act.is_unknown_failure(text) from public, anon;
grant execute on function act.is_unknown_failure(text) to authenticated, service_role;

create or replace function core.act_reply_state(p_lane text, p_connection uuid, p_thread_id text, p_message_id text)
returns table (pending_id uuid, blocked boolean, already_sent_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  select
    (select a.id from act.proposed_actions a
     where a.lane_id = p_lane and a.connection_id = p_connection and a.action_type in ('email.send', 'email.save_draft')
       and a.status = 'proposed' and a.expires_at > pg_catalog.now() and a.payload_purged_at is null
       and a.payload -> 'inReplyTo' ->> 'messageId' = p_message_id
     order by a.created_at desc limit 1),
    exists (select 1 from act.proposed_actions a
            where a.lane_id = p_lane and a.connection_id = p_connection and a.payload -> 'inReplyTo' ->> 'threadId' = p_thread_id
              and (a.status in ('approved', 'executing')
                   or (a.status = 'failed' and act.is_unknown_failure(a.failure_code) and a.updated_at > pg_catalog.now() - interval '24 hours'))),
    (select a.verified_at from act.proposed_actions a
     where a.lane_id = p_lane and a.connection_id = p_connection and a.action_type = 'email.send' and a.status = 'verified'
       and a.payload -> 'inReplyTo' ->> 'threadId' = p_thread_id
     order by a.verified_at desc nulls last limit 1);
$$;
comment on function core.act_reply_state(text, uuid, text, text) is 'Reply drawer state (T-234): the pending proposal for a message, whether an earlier action in the thread may have gone out, and when a reply was last verified. Invoker, RLS applies.';
revoke all on function core.act_reply_state(text, uuid, text, text) from public, anon;
grant execute on function core.act_reply_state(text, uuid, text, text) to authenticated, service_role;

create or replace function act.insert_proposal(
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
  -- T-231d: jobs (the daily briefing) have their own, smaller cap, so mail that lands in "attention" can never fill the
  -- lane's slots and lock the owner's own proposals out (T-231d security review M4).
  if p_proposer_kind = 'job' and p_supersedes is null
     and (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.proposer_kind = 'job'
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

create or replace function act.approve(p_lane text, p_id uuid, p_hash_seen text) returns text
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
    -- T-234 part 3 re-check M1: a draft made BEFORE the latest reply in this conversation went out is stale. Approving it
    -- would send a second reply without the owner's explicit confirmation (a pending briefing draft on another message
    -- of the thread, or a draft saved in a second tab while the first was sending). Saving an edit makes a new proposal
    -- dated after that send, which is the explicit confirmation; the drawer's "Send another reply" does the same.
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

revoke all on function act.insert_proposal(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean, uuid) from public, anon, authenticated;
comment on function act.approve(text, uuid, text) is
  'Approves the exact payload: aal2, TOTP step-up within step_up_max_age_s (amr), owner of the lane, hash seen = stored hash, not expired, approvals_live, type allowed by lane policy, connection granted compose, no other approved/executing/failed-unknown action in the same thread (check_sent_first), not made before the latest verified reply in the thread (already_replied).';
revoke all on function act.approve(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function act.approve(text, uuid, text) to authenticated;
