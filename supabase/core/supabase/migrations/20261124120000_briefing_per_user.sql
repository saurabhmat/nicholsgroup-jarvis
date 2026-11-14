-- T-247 part 3: briefings per person. A briefing is built from, saved for and readable by ONE user, from that user's own mailboxes
-- and calendars only (part 2 filters the reads). What changes here:
--   * Who may have a briefing: a member who holds own_mail in the lane (core.may_brief), not "owner role + briefing view". So an
--     admin_technical member with their own mailbox gets their own briefing; nobody else's. brief.briefings_guard, the two SELECT
--     policies and every briefing function use the same gate. (The `briefing` view still gates the lane's shared news digest.)
--   * Run claims: one running run, the Regenerate limit and the 10-minute pause are now PER OWNER (two users do not block each other);
--     the daily cap (6 claims per lane and New York day) stays lane-wide: it is the lane's cost bound. Scheduled claims already were per owner.
--   * Bodies otherwise unchanged from 20261111120000 / 20261114100000 / 20261119100000: the gate text is the only edit, apart from the
--     claim gates described above.
-- Tests: 319_mail_ownership.test.sql; 282, 306, 311 adjusted.

create or replace function brief.briefings_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(new.content -> 'replies') = 'array' and pg_catalog.jsonb_array_length(new.content -> 'replies') > 0
     and not exists (select 1 from core.lane_policies p where p.lane_id = new.lane_id and p.store_outbound_drafts) then
    raise exception 'brief.briefings: reply drafts need the lane policy store_outbound_drafts' using errcode = '23514';
  end if;
  if not exists (select 1 from core.lanes l where l.code = new.lane_id and l.enabled) then
    raise exception 'brief.briefings: lane is not enabled' using errcode = '22023';
  end if;
  -- T-247: only a member who holds own_mail in the lane (so one with a mailbox of their own) gets a briefing; checked again here so a
  -- direct service_role insert cannot put a briefing on another member's Home.
  if not core.may_brief(new.owner_user_id, new.lane_id) then
    raise exception 'brief.briefings: the owner does not hold own_mail in this lane' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function brief.briefings_guard() from public, anon, authenticated;

drop policy if exists briefings_select on brief.briefings;
create policy briefings_select on brief.briefings
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[])
    and owner_user_id = (select auth.uid())
  );
drop policy if exists briefing_runs_select on brief.briefing_runs;
create policy briefing_runs_select on brief.briefing_runs
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'own_mail'))::text[])
    and owner_user_id = (select auth.uid())
  );

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
    if (select count(*) from brief.briefing_runs r where r.lane_id = p_lane and r.day = v_today) >= 6 then
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
revoke all on function brief.briefing_claim(text, uuid, text) from public, anon, authenticated, service_role;
-- The owner's wrappers: AAL2 + lane owner + briefing view (same checks as core.briefing_save_own).
create or replace function core.briefing_claim_auto(p_lane text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lane is null or not core.may_brief(v_uid, p_lane) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return brief.briefing_claim(p_lane, v_uid, 'auto');
end;
$$;
comment on function core.briefing_claim_auto(text) is
  'T-235: the signed-in lane owner (AAL2, briefing view) claims a background run when Home finds the briefing stale. Returns {id, gate}.';
revoke all on function core.briefing_claim_auto(text) from public, anon, service_role;
grant execute on function core.briefing_claim_auto(text) to authenticated;

create or replace function core.briefing_claim_regenerate(p_lane text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lane is null or not core.may_brief(v_uid, p_lane) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return brief.briefing_claim(p_lane, v_uid, 'regenerate');
end;
$$;
comment on function core.briefing_claim_regenerate(text) is
  'T-235: the signed-in lane owner (AAL2, briefing view) claims a Regenerate run: once per 30 minutes per lane, inside the daily cap. Returns {id, gate}.';
revoke all on function core.briefing_claim_regenerate(text) from public, anon, service_role;
grant execute on function core.briefing_claim_regenerate(text) to authenticated;

-- The app could not start a claimed run (an error between the claim and the background run): the caller releases their OWN open
-- claim, closed as 'lost' (it still counts toward the daily cap: a model call may have been paid), so no claim leaks. Owner, AAL2, briefing view; only the caller's own row.
create or replace function core.briefing_claim_release(p_lane text, p_claim uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n integer;
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lane is null or p_claim is null or not core.may_brief(v_uid, p_lane) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update brief.briefing_runs r set status = 'lost', finished_at = pg_catalog.clock_timestamp()
   where r.id = p_claim and r.lane_id = p_lane and r.owner_user_id = v_uid and r.status = 'running' and r.kind in ('auto', 'regenerate', 'manual');
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
comment on function core.briefing_claim_release(text, uuid) is
  'T-235: the claiming owner (AAL2, briefing view) releases their own open claim; closed as lost, still counted toward the daily cap (re-check H1).';
revoke all on function core.briefing_claim_release(text, uuid) from public, anon, service_role;
grant execute on function core.briefing_claim_release(text, uuid) to authenticated;

-- The 06:30 job (service_role): records the run; counts toward the cap, is never refused by it. The owner must still hold the
-- owner role and the briefing view (the same re-check as the briefings guard).
-- Returns {id, gate} (gate 'done' when today already has a finished scheduled run). The return type changed from uuid, so the
-- function is dropped first (re-runnable; grants follow below).
drop function if exists core.briefing_claim_schedule(text, uuid);
create function core.briefing_claim_schedule(p_lane text, p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
begin
  if p_lane is null or p_owner is null or not core.may_brief(p_owner, p_lane) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_res := brief.briefing_claim(p_lane, p_owner, 'schedule');
  return v_res;
end;
$$;
comment on function core.briefing_claim_schedule(text, uuid) is
  'T-235: records a scheduled run for tracking (counts toward the daily cap, never blocked). service_role only; the owner is re-checked.';
revoke all on function core.briefing_claim_schedule(text, uuid) from public, anon, authenticated;
grant execute on function core.briefing_claim_schedule(text, uuid) to service_role;

-- ---------------------------------------------------------------- what Home needs to know (cheap, polled)
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
         (select count(*)::integer from brief.briefing_runs r where r.lane_id = p_lane and r.day = v_today),
         (select max(b.prepared_at) from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = v_uid and b.status <> 'failed'),
         (select max(b.prepared_at) from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = v_uid);
end;
$$;
comment on function core.briefing_run_state(text) is
  'T-235: for the lane owner (AAL2, briefing view): a run is open (2 min), the last Regenerate, runs today (New York day, every claim incl. lost; lane-wide by design), the caller''s newest non-failed and newest briefing times. No row for anyone else.';
revoke all on function core.briefing_run_state(text) from public, anon, service_role;
grant execute on function core.briefing_run_state(text) to authenticated;
-- ---------------------------------------------------------------- the saves mark the claim finished
-- Copy of core.briefing_save (20261111120000_brief_briefings.sql) plus the claim close.
create or replace function core.briefing_save(p_lane text, p_owner uuid, p_trigger text, p_status text, p_window_from timestamptz,
                                              p_window_to timestamptz, p_content jsonb, p_coverage jsonb, p_source_refs jsonb, p_model text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lane is null or p_owner is null then
    raise exception 'lane and owner are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '22023';
  end if;
  insert into brief.briefings (lane_id, owner_user_id, trigger, status, window_from, window_to, content, coverage, source_refs, model)
  values (p_lane, p_owner, p_trigger, p_status, p_window_from, p_window_to, coalesce(p_content, '{}'), coalesce(p_coverage, '[]'),
          coalesce(p_source_refs, '[]'), p_model)
  returning brief.briefings.id into v_id;
  perform brief.briefing_runs_close(p_lane, p_owner, array['schedule'], p_status);
  return v_id;
end;
$$;

-- Copy of core.briefing_save_own (20261111120000_brief_briefings.sql). Changes: the 2-minute cooldown is skipped while the owner
-- has an open claim (auto, regenerate or manual: its gates already passed), and the save closes that claim.
create or replace function core.briefing_save_own(p_lane text, p_status text, p_window_from timestamptz, p_window_to timestamptz,
                                                  p_content jsonb, p_coverage jsonb, p_source_refs jsonb, p_model text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lane is null or not core.may_brief(v_uid, p_lane) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Serialise attempts per owner and lane for this transaction, then apply the cooldown.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brief.briefings:' || p_lane || ':' || v_uid::text, 0));
  if not exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = v_uid and r.status = 'running'
                 and r.kind in ('auto', 'regenerate', 'manual') and r.started_at > pg_catalog.clock_timestamp() - interval '10 minutes')
     and exists (select 1 from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = v_uid
                 and b.prepared_at > pg_catalog.clock_timestamp() - interval '2 minutes') then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  insert into brief.briefings (lane_id, owner_user_id, trigger, status, window_from, window_to, content, coverage, source_refs, model)
  values (p_lane, v_uid, 'manual', p_status, p_window_from, p_window_to, coalesce(p_content, '{}'), coalesce(p_coverage, '[]'),
          coalesce(p_source_refs, '[]'), p_model)
  returning brief.briefings.id into v_id;
  perform brief.briefing_runs_close(p_lane, v_uid, array['auto', 'regenerate', 'manual'], p_status);
  return v_id;
end;
$$;
comment on function core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) is
  'T-231c / T-235: the signed-in lane owner (AAL2, briefing view) saves their own briefing; 2-minute cooldown unless a claimed run is open; closes the claim.';
revoke all on function core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) from public, anon;
grant execute on function core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) to authenticated;
revoke all on function core.briefing_save(text, uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function core.briefing_save(text, uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) to service_role;
-- ---------------------------------------------------------------- 1. refresh claim
create or replace function core.briefing_claim_refresh(p_lane text, p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lane is null or p_owner is null or not core.may_brief(p_owner, p_lane) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return brief.briefing_claim(p_lane, p_owner, 'auto');
end;
$$;
comment on function core.briefing_claim_refresh(text, uuid) is
  'T-238: the briefing.refresh job (service_role) claims a background run after new mail, through the same gates as Home''s automatic run (3 h stale, one running, 6 per lane and day, 10-minute pause). Owner role and briefing view re-checked. Returns {id, gate}.';
revoke all on function core.briefing_claim_refresh(text, uuid) from public, anon, authenticated;
grant execute on function core.briefing_claim_refresh(text, uuid) to service_role;
