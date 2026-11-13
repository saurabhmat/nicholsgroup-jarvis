-- T-238: sync freshness.
--
-- 1. Briefing refresh after new mail. core.briefing_claim_refresh(lane, owner) lets the service role (the Inngest job
--    briefing.refresh) ask the EXISTING run claim (brief.briefing_claim, kind 'auto'): stale after 3 h, one running per lane,
--    6 per lane and New York day, 10-minute pause. Same gates as Home's automatic run; the claim answers {id, gate} and a gate
--    means no model call. The owner role and the briefing view are re-checked. core.briefing_claim_refresh_close lets the job finish
--    its claim after the save (core.briefing_save is unchanged).
-- 2. core.job_failures: one row per (lane, scheduled function, connection or '') with the consecutive-failure count, so admins
--    can be told when a scheduled function failed 3 times in a row. Ids, counters, times and a short code only: no message, no
--    content. Self-bounding: one row per key (functions x connections of a lane), updated in place, never inserted per failure.
--    Read: owner and admin_technical (view 'health') at AAL2; written only by the definer functions below (service_role).
-- 3. core.sync_now_requests + core.sync_now_claim(lane): the rate limit of "Sync now" (one per lane per 2 minutes), atomic.
--    Owner or admin_technical at AAL2 only; returns {ok, retry_after_seconds}.
-- Tests: 311_sync_freshness.test.sql (cross-lane, AAL1, role, grants, counting, reset, alert once per streak, rate limit).
-- Safe to re-run: create or replace / if not exists / drop-if-exists only.

-- ---------------------------------------------------------------- 1. refresh claim
create or replace function core.briefing_claim_refresh(p_lane text, p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lane is null or p_owner is null or not core.has_lane_role(p_owner, p_lane, array['owner']) or not (p_lane = any (core.allowed_lanes(p_owner, 'briefing'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return brief.briefing_claim(p_lane, p_owner, 'auto');
end;
$$;
comment on function core.briefing_claim_refresh(text, uuid) is
  'T-238: the briefing.refresh job (service_role) claims a background run after new mail, through the same gates as Home''s automatic run (3 h stale, one running, 6 per lane and day, 10-minute pause). Owner role and briefing view re-checked. Returns {id, gate}.';
revoke all on function core.briefing_claim_refresh(text, uuid) from public, anon, authenticated;
grant execute on function core.briefing_claim_refresh(text, uuid) to service_role;

-- The refresh job closes its own claim after its save (core.briefing_save is unchanged: it closes only 'schedule' claims, and must
-- not end a claim an owner's Home opened). Only the owner's open 'auto' claims; 'done' or 'failed'; service_role only.
create or replace function core.briefing_claim_refresh_close(p_lane text, p_owner uuid, p_status text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or p_owner is null or p_status not in ('done', 'failed', 'lost') then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  update brief.briefing_runs r
     set status = p_status, finished_at = pg_catalog.clock_timestamp()
   where r.lane_id = p_lane and r.owner_user_id = p_owner and r.status = 'running' and r.kind = 'auto';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.briefing_claim_refresh_close(text, uuid, text) is
  'T-238: the briefing.refresh job finishes the owner''s open auto claim after its run (done, failed or lost; a lost claim still counts toward the daily cap). service_role only.';
revoke all on function core.briefing_claim_refresh_close(text, uuid, text) from public, anon, authenticated;
grant execute on function core.briefing_claim_refresh_close(text, uuid, text) to service_role;

-- ---------------------------------------------------------------- 2. core.job_failures
create table if not exists core.job_failures (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  function_id text not null check (function_id ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  -- A connection id (conn.sync) or '' (a function that serves the whole lane).
  connection_id text not null default '' check (connection_id = '' or connection_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  -- When the current streak began (its first failure): "failed 3 times in a row since ...".
  streak_started_at timestamptz,
  last_failure_at timestamptz,
  -- A short code (a connector error kind or 'failed'); never a message.
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z][a-z_]{0,40}$'),
  last_success_at timestamptz,
  -- Set once when the streak reaches 3; cleared by the next success. Drives the in-app banner and the once-per-streak log line.
  alerted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (lane_id, function_id, connection_id)
);
comment on table core.job_failures is
  'Consecutive failures of scheduled functions per (lane, function, connection or empty) (T-238). Counters, times and a short error code only; one row per key, updated in place. Read by owner and admin_technical; written by definer functions.';

alter table core.job_failures enable row level security;
drop policy if exists job_failures_select on core.job_failures;
create policy job_failures_select on core.job_failures
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );
revoke all on core.job_failures from public, anon, authenticated, service_role;
grant select on core.job_failures to authenticated;
grant select on core.job_failures to service_role;

-- A failed run (after Inngest's retries). Counts once; reaching 3 sets alerted_at once per streak and returns alert = true.
create or replace function core.job_failure_record(p_lane text, p_function text, p_connection text, p_code text)
returns table (consecutive_failures integer, alert boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conn text := coalesce(p_connection, '');
  v_code text := case when p_code ~ '^[a-z][a-z_]{0,40}$' then p_code else 'failed' end;
  v_n integer;
  v_alerted timestamptz;
begin
  if p_lane is null or p_function is null or not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not available' using errcode = '22023';
  end if;
  insert into core.job_failures as f (lane_id, function_id, connection_id, consecutive_failures, streak_started_at, last_failure_at, last_error_code)
  values (p_lane, p_function, v_conn, 1, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), v_code)
  on conflict (lane_id, function_id, connection_id) do update
    set consecutive_failures = f.consecutive_failures + 1,
        streak_started_at = case when f.consecutive_failures = 0 then pg_catalog.clock_timestamp() else f.streak_started_at end,
        last_failure_at = pg_catalog.clock_timestamp(),
        last_error_code = v_code,
        updated_at = pg_catalog.now()
  returning f.consecutive_failures, f.alerted_at into v_n, v_alerted;
  if v_n >= 3 and v_alerted is null then
    update core.job_failures f set alerted_at = pg_catalog.clock_timestamp()
     where f.lane_id = p_lane and f.function_id = p_function and f.connection_id = v_conn;
    return query select v_n, true;
  else
    return query select v_n, false;
  end if;
end;
$$;
comment on function core.job_failure_record(text, text, text, text) is
  'T-238: a scheduled function failed (after retries). Increments the streak; at 3 sets alerted_at once and returns alert = true. service_role only.';
revoke all on function core.job_failure_record(text, text, text, text) from public, anon, authenticated;
grant execute on function core.job_failure_record(text, text, text, text) to service_role;

-- A successful run resets the streak and clears the alert. A key that never failed gets no row.
create or replace function core.job_failure_clear(p_lane text, p_function text, p_connection text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lane is null or p_function is null then
    raise exception 'lane and function are required' using errcode = '22004';
  end if;
  update core.job_failures f
     set consecutive_failures = 0, streak_started_at = null, alerted_at = null, last_success_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.now()
   where f.lane_id = p_lane and f.function_id = p_function and f.connection_id = coalesce(p_connection, '')
     and (f.consecutive_failures > 0 or f.alerted_at is not null);
end;
$$;
comment on function core.job_failure_clear(text, text, text) is
  'T-238: a scheduled function succeeded; resets its failure streak and clears the alert. service_role only.';
revoke all on function core.job_failure_clear(text, text, text) from public, anon, authenticated;
grant execute on function core.job_failure_clear(text, text, text) to service_role;

-- ---------------------------------------------------------------- 3. Sync now rate limit
create table if not exists core.sync_now_requests (
  lane_id text primary key references core.lanes (code) on update restrict on delete restrict,
  requested_by uuid not null references core.users (id) on update restrict on delete cascade,
  requested_at timestamptz not null default pg_catalog.clock_timestamp()
);
comment on table core.sync_now_requests is
  'The last "Sync now" per lane (T-238), for the one-per-2-minutes limit. One row per lane, updated in place; who and when only.';
alter table core.sync_now_requests enable row level security;
drop policy if exists sync_now_requests_select on core.sync_now_requests;
create policy sync_now_requests_select on core.sync_now_requests
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );
revoke all on core.sync_now_requests from public, anon, authenticated, service_role;
grant select on core.sync_now_requests to authenticated;
grant select on core.sync_now_requests to service_role;

create or replace function core.sync_now_claim(p_lane text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at timestamptz;
  v_last timestamptz;
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lane is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical'])
     or not (p_lane = any (core.allowed_lanes(v_uid, 'connections'))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- One statement, atomic per lane: the row is taken only when the last request is more than 2 minutes old.
  insert into core.sync_now_requests as r (lane_id, requested_by, requested_at)
  values (p_lane, v_uid, pg_catalog.clock_timestamp())
  on conflict (lane_id) do update set requested_by = v_uid, requested_at = pg_catalog.clock_timestamp()
    where r.requested_at <= pg_catalog.clock_timestamp() - interval '2 minutes'
  returning r.requested_at into v_at;
  if v_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'retry_after_seconds', 0);
  end if;
  select r.requested_at into v_last from core.sync_now_requests r where r.lane_id = p_lane;
  return pg_catalog.jsonb_build_object('ok', false,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_last + interval '2 minutes' - pg_catalog.clock_timestamp())))::integer));
end;
$$;
comment on function core.sync_now_claim(text) is
  'T-238: "Sync now" rate limit. Owner or admin_technical of the lane at AAL2 (connections view); one request per lane per 2 minutes. Returns {ok, retry_after_seconds}.';
revoke all on function core.sync_now_claim(text) from public, anon, service_role;
grant execute on function core.sync_now_claim(text) to authenticated;
