-- T-235 part 1: automatic AI summary. brief.briefing_runs tracks every attempt to prepare a briefing (one row per claim) so the
-- app can start a background run when the owner opens Home and the latest briefing is old, without a Run button, and still
-- hold a hard cost bound: at most 6 runs per lane per New York day (auto + regenerate + manual + schedule all count; claims closed
-- as 'lost' count too: a released or crashed run may already have paid for a model call), one run at a time per
-- lane, a 10-minute pause after an auto/regenerate/manual attempt, and one Regenerate per 30 minutes.
--
-- Claim kinds: auto (Home opened, latest briefing older than 3 hours), regenerate (the owner's menu item), manual (kept for
-- older rows and direct owner saves), schedule (the 06:30 job; counts toward the cap but is never blocked by it or by auto runs).
-- The claim functions RETURN a gate code instead of raising ({id, gate}), so the closing of a lost claim (open for more than
-- 10 minutes -> lost) is committed even when the claim is then refused (T-234 part 4 re-check M1). A lost claim IS counted
-- toward the cap; this is bounded by the one-running gate (2 min) and the 10-minute auto pause, so a crash loop cannot run away.
-- The run state and the cap are lane-wide by design (one cost cap per lane, whichever owner opens Home).
-- A schedule claim: a running one is reused by an Inngest retry; a day with a finished run answers 'done'; a retry after a
-- failure adds a new, counted claim.
-- The run's save marks the claim finished: core.briefing_save_own (owner) and core.briefing_save (job) close the caller's open
-- claims. While an owner's claim is open, core.briefing_save_own skips its 2-minute cooldown (the claim gates are stricter and
-- already passed); without a claim the 2-minute cooldown is unchanged.
-- Read: AAL2 + briefing view + own rows (the owner). Write: only the definer functions below.
-- Tests: 306_briefing_auto_runs.test.sql (cap, stale, running, regenerate limit, cross-lane, AAL1, non-owner, anon, grants).

create table if not exists brief.briefing_runs (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  owner_user_id uuid not null references core.users (id) on update restrict on delete cascade,
  kind text not null check (kind in ('auto', 'regenerate', 'schedule', 'manual')),
  -- The New York date the claim was made (the daily cap counts per lane and day).
  day date not null default ((pg_catalog.clock_timestamp() at time zone 'America/New_York')::date),
  started_at timestamptz not null default pg_catalog.clock_timestamp(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'lost')),
  check ((status = 'running') = (finished_at is null))
);
-- Re-runnable on a database that already has the first version of this table (before 'lost' existed).
alter table brief.briefing_runs drop constraint if exists briefing_runs_status_check;
alter table brief.briefing_runs add constraint briefing_runs_status_check check (status in ('running', 'done', 'failed', 'lost'));
comment on table brief.briefing_runs is
  'Briefing run claims (T-235): one row per attempt (auto, regenerate, manual, schedule) with its outcome; metadata only, no content. Owner reads own rows; written only by definer functions.';
create index if not exists briefing_runs_lane_started_idx on brief.briefing_runs (lane_id, started_at desc);
create index if not exists briefing_runs_owner_idx on brief.briefing_runs (owner_user_id);

alter table brief.briefing_runs enable row level security;
drop policy if exists briefing_runs_select on brief.briefing_runs;
create policy briefing_runs_select on brief.briefing_runs
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'briefing'))::text[])
    and owner_user_id = (select auth.uid())
  );
revoke all on brief.briefing_runs from public, anon, authenticated, service_role;
grant select on brief.briefing_runs to authenticated;
grant select on brief.briefing_runs to service_role;

-- ---------------------------------------------------------------- close a run (called by the saves)
create or replace function brief.briefing_runs_close(p_lane text, p_owner uuid, p_kinds text[], p_status text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update brief.briefing_runs r
     set status = case when p_status = 'failed' then 'failed' else 'done' end, finished_at = pg_catalog.clock_timestamp()
   where r.lane_id = p_lane and r.owner_user_id = p_owner and r.status = 'running' and r.kind = any (p_kinds);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function brief.briefing_runs_close(text, uuid, text[], text) is
  'T-235: marks the owner''s open claims of the given kinds finished (done, or failed for a failed briefing). Called by the briefing saves; service_role and definer code only.';
revoke all on function brief.briefing_runs_close(text, uuid, text[], text) from public, anon, authenticated;
grant execute on function brief.briefing_runs_close(text, uuid, text[], text) to service_role;

-- ---------------------------------------------------------------- the claim (gates in one place)
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
    if exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.status = 'running' and r.started_at > pg_catalog.clock_timestamp() - interval '2 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'running');
    end if;
    -- Every claim of the day counts, lost ones too (T-235 part 1 re-check H1): a released or crashed run may already have
    -- paid for a model call, so the 6 per lane and day stay a hard bound.
    if (select count(*) from brief.briefing_runs r where r.lane_id = p_lane and r.day = v_today) >= 6 then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'cap_reached');
    end if;
    if p_kind = 'regenerate' and exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.kind = 'regenerate'
                                         and r.started_at > pg_catalog.clock_timestamp() - interval '30 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'rate_limited');
    end if;
    if p_kind = 'auto' and exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.kind in ('auto', 'regenerate', 'manual')
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
  if p_lane is null or not core.has_lane_role(v_uid, p_lane, array['owner']) or not (p_lane = any (core.allowed_lanes(v_uid, 'briefing'))) then
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
  if p_lane is null or not core.has_lane_role(v_uid, p_lane, array['owner']) or not (p_lane = any (core.allowed_lanes(v_uid, 'briefing'))) then
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
  if p_lane is null or p_claim is null or not core.has_lane_role(v_uid, p_lane, array['owner']) or not (p_lane = any (core.allowed_lanes(v_uid, 'briefing'))) then
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
  if p_lane is null or p_owner is null or not core.has_lane_role(p_owner, p_lane, array['owner']) or not (p_lane = any (core.allowed_lanes(p_owner, 'briefing'))) then
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
     or not core.has_lane_role(v_uid, p_lane, array['owner']) or not (p_lane = any (core.allowed_lanes(v_uid, 'briefing'))) then
    return;
  end if;
  return query
  select exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.status = 'running' and r.started_at > pg_catalog.clock_timestamp() - interval '2 minutes'),
         (select max(r.started_at) from brief.briefing_runs r where r.lane_id = p_lane and r.kind = 'regenerate'),
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
  if p_lane is null or not core.has_lane_role(v_uid, p_lane, array['owner'])
     or not (p_lane = any (core.allowed_lanes(v_uid, 'briefing'))) then
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

-- ---------------------------------------------------------------- retention (metadata only; ~6 rows per lane and day)
-- Deletes a lane's claims whose New York day is more than p_keep_days ago (floor 1 day). Refuses a disabled or unknown lane.
create or replace function brief.briefing_runs_purge(p_lane text, p_keep_days integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or p_keep_days is null then
    raise exception 'lane and keep are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '22023';
  end if;
  if p_keep_days < 1 then
    raise exception 'keep at least 1 day of briefing runs' using errcode = '22023';
  end if;
  delete from brief.briefing_runs r
   where r.lane_id = p_lane and r.day < (pg_catalog.clock_timestamp() at time zone 'America/New_York')::date - p_keep_days;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function brief.briefing_runs_purge(text, integer) is
  'T-235 retention: deletes a lane''s briefing run claims older than p_keep_days New York days (floor 1). service_role only.';
revoke all on function brief.briefing_runs_purge(text, integer) from public, anon, authenticated;
grant execute on function brief.briefing_runs_purge(text, integer) to service_role;
create or replace function core.briefing_runs_purge(p_lane text, p_keep_days integer)
returns integer
language sql
security invoker
set search_path = ''
as $$ select brief.briefing_runs_purge(p_lane, p_keep_days); $$;
revoke all on function core.briefing_runs_purge(text, integer) from public, anon, authenticated;
grant execute on function core.briefing_runs_purge(text, integer) to service_role;
