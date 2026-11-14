-- T-247 review fixes (security + code review, Nov 14, 2026).
--  1. HIGH: briefings stored before the cut-over were built from the WHOLE lane's mail and are owned by a lane owner. They are derived data and are
--     removed (regenerated per person from the user's own mailboxes). Pending JOB email drafts made before the cut-over (made by a briefing that saw the
--     whole lane) are withdrawn too (proposed -> invalidated, body purged). Nothing else stores mail-derived content owned by a user: run claims hold
--     metadata only; email proposals/approvals are visible only to the connection's owner (a draft for Saurabh's mailbox is Saurabh's alone); assistant
--     results are stored as references only; brain pages hold the user's own answers.
--  2. act.insert_proposal: the mailbox owner must hold the role that may approve the type (no undecidable draft, e.g. for a viewer); the pending caps
--     (20 and 6 for jobs) are per mailbox owner for email.
--  3. The briefing daily cap (6) is per owner, and runs_today shows only the caller's runs (decision: the cap is a cost bound per person, so one user cannot starve the other).
delete from brief.briefings where prepared_at < pg_catalog.clock_timestamp();
do $w$
declare r record;
begin
  for r in select a.lane_id, a.id from act.proposed_actions a where a.status = 'proposed' and a.proposer_kind = 'job' and a.action_type like 'email.%' loop
    perform act.withdraw_proposed(r.lane_id, r.id, 'cut-over: made before drafts became private');
  end loop;
end
$w$;

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
  select c.provider, c.external_account_id, c.owner_user_id into v_provider, v_account, v_owner from core.connections c
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
  elsif v_provider not in ('google', 'microsoft') then
    raise exception 'act: the connection does not belong to this lane and provider' using errcode = '23503';
  end if;
  -- T-247: an email proposal is made for the mailbox owner (a job names them as proposer_user_id): nobody else's mailbox, and the owner must still hold own_mail here.
  -- (membership read directly, not through core.allowed_lanes: this definer function is reached only by service_role code, and the check
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
  -- The cap counts only unexpired proposals (expiry is lazy: an expired row still says 'proposed' until act.expire_stale).
  -- T-247 review: per mailbox owner for email (one user cannot fill the other's slots); other types stay lane-wide among themselves.
  if (select count(*) from act.proposed_actions a where a.lane_id = p_lane and a.status = 'proposed' and a.expires_at > pg_catalog.now()
        and (a.action_type like 'email.%') = (p_type like 'email.%') and (p_type not like 'email.%' or a.proposer_user_id = p_proposer_user)
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

create or replace function brief.briefing_claim(p_lane text, p_uid uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/New_York')::date;
  v_id uuid;
begin
  if p_lane is null or p_lane !~ '^[A-Z]{1,8}$' or p_uid is null or p_kind not in ('auto', 'regenerate', 'schedule', 'manual') then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brief.briefing_runs:' || p_lane, 0));
  -- A claim open for more than 10 minutes was lost (crash, timeout): close it as lost (still counted toward the cap). Committed
  -- step: every refusal below returns normally instead of raising.
  update brief.briefing_runs r set status = 'lost', finished_at = pg_catalog.clock_timestamp()
   where r.lane_id = p_lane and r.status = 'running' and r.started_at < pg_catalog.clock_timestamp() - interval '10 minutes';
  if p_kind = 'schedule' then
    -- Per lane + owner + New York day (T-235 part 1 re-check M1): an Inngest retry reuses a claim that is still RUNNING; a
    -- day that already has a finished ('done') schedule run answers gate 'done' (the job skips); after a failed or lost run a
    -- retry inserts a NEW claim, so every model attempt counts toward the cap.
    select r.id into v_id from brief.briefing_runs r
     where r.lane_id = p_lane and r.owner_user_id = p_uid and r.kind = 'schedule' and r.day = v_today and r.status = 'running'
     order by r.started_at limit 1;
    if v_id is not null then
      return pg_catalog.jsonb_build_object('id', v_id, 'gate', null);
    end if;
    select r.id into v_id from brief.briefing_runs r
     where r.lane_id = p_lane and r.owner_user_id = p_uid and r.kind = 'schedule' and r.day = v_today and r.status = 'done'
     order by r.started_at limit 1;
    if v_id is not null then
      return pg_catalog.jsonb_build_object('id', v_id, 'gate', 'done');
    end if;
  else
    if p_kind = 'auto' and exists (select 1 from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = p_uid and b.status <> 'failed'
                                   and b.prepared_at > pg_catalog.clock_timestamp() - interval '3 hours') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'not_stale');
    end if;
    if exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = p_uid and r.status = 'running' and r.started_at > pg_catalog.clock_timestamp() - interval '2 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'running');
    end if;
    -- Every claim of the day counts, lost ones too (T-235 part 1 re-check H1): a released or crashed run may already have
    -- paid for a model call, so the 6 per lane and day stay a hard bound.
    if (select count(*) from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = p_uid and r.day = v_today) >= 6 then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'cap_reached');
    end if;
    if p_kind = 'regenerate' and exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = p_uid and r.kind = 'regenerate'
                                         and r.started_at > pg_catalog.clock_timestamp() - interval '30 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'rate_limited');
    end if;
    if p_kind = 'auto' and exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = p_uid and r.kind in ('auto', 'regenerate', 'manual')
                                   and r.started_at > pg_catalog.clock_timestamp() - interval '10 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'cooldown');
    end if;
  end if;
  insert into brief.briefing_runs (lane_id, owner_user_id, kind) values (p_lane, p_uid, p_kind) returning id into v_id;
  return pg_catalog.jsonb_build_object('id', v_id, 'gate', null);
end;
$$;
comment on function brief.briefing_claim(text, uuid, text) is
  'T-235: claims one briefing run: stale (auto: latest briefing older than 3 h), one running per lane (2 min), 6 per lane and New York day (every claim counts, lost ones too), Regenerate once per 30 min, 10 min pause after an auto/regenerate/manual attempt. A schedule claim is never gated by the cap; a running one is reused, a finished day answers gate done, a failed retry adds a counted claim. Returns {id, gate}. Definer wrappers only.';

create or replace function core.briefing_run_state(p_lane text)
returns table (running boolean, last_regenerate_at timestamptz, runs_today integer, latest_prepared_at timestamptz, last_attempt_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/New_York')::date;
begin
  -- Not the owner / not AAL2 / no view: no row (the card then shows no controls).
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' or p_lane is null
     or not core.may_brief(v_uid, p_lane) then
    return;
  end if;
  return query
  select exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = v_uid and r.status = 'running' and r.started_at > pg_catalog.clock_timestamp() - interval '2 minutes'),
         (select max(r.started_at) from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = v_uid and r.kind = 'regenerate'),
         (select count(*)::integer from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = v_uid and r.day = v_today),
         (select max(b.prepared_at) from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = v_uid and b.status <> 'failed'),
         (select max(b.prepared_at) from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = v_uid);
end;
$$;
comment on function core.briefing_run_state(text) is
  'T-235: for the lane owner (AAL2, briefing view): a run is open (2 min), the last Regenerate, runs today (New York day, every claim incl. lost; lane-wide by design), the caller''s newest non-failed and newest briefing times. No row for anyone else.';

revoke all on function act.insert_proposal(text, text, uuid, jsonb, jsonb, integer, text, text, jsonb, text, uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function brief.briefing_claim(text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function core.briefing_run_state(text) from public, anon, service_role;
grant execute on function core.briefing_run_state(text) to authenticated;
