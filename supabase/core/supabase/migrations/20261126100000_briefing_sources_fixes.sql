-- T-270 (first live Microsoft run): three fixes in the database.
--   1. core.briefing_coverage: a stream's last_sync_at is its OWN cursor time only; the fallback to the connection's last succeeded run is removed
--      (it showed Mail as synced with the calendar run's time). Same signature, columns and grants (create or replace).
--   2. brief.briefing_sources_newer(lane, user): true when one of the user's live mail/calendar connections stored a mail cursor and its FIRST
--      succeeded sync finished after the user's newest non-failed briefing was prepared (the summary was made before the source had data).
--      brief.briefing_claim: an 'auto' claim no longer answers not_stale for such a summary; every other gate (one running, 6 a day, 10-minute pause)
--      is unchanged, so it renews once. Body otherwise identical to 20261124150000.
--   3. core.briefing_sources_newer(lane): the owner's cheap read of (2) for Home (AAL2 + own_mail, like core.briefing_run_state).
-- No table, column, policy or grant on a table changes. Tests: 324_briefing_sources_fixes.test.sql (and 280 adjusted).

create or replace function core.briefing_coverage(p_lane text, p_owner uuid default null)
returns table (
  stream text,
  account text,
  connection_id uuid,
  provider text,
  status text,
  configured boolean,
  last_sync_at timestamptz,
  error_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reader uuid;
  v_mail boolean;
  v_cal boolean;
  v_boxes text[];
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if pg_catalog.current_setting('role', true) <> 'service_role' and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return;
  end if;
  v_reader := core.mail_reader(p_owner);
  if v_reader is null then
    return;
  end if;
  -- T-247: the reader's own mail and calendar (own_mail view); never another user's accounts.
  v_mail := p_lane = any (core.allowed_lanes(v_reader, 'own_mail'));
  v_cal := v_mail;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    return;
  end if;
  if not (v_mail or v_cal) then
    return;
  end if;

  select coalesce(array_agg(distinct lower(b.value)), '{}')
    into v_boxes
  from core.lane_config_current c,
       pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(c.config -> 'mailboxes') = 'array' then c.config -> 'mailboxes' else '[]'::jsonb end) b(value)
  where c.lane_id = p_lane;

  return query
  with accounts as (
    -- the reader's own live mail/calendar connections of the lane (one row per address)
    select lower(c.external_account_id) as account from core.connections c
    where c.lane_id = p_lane and c.owner_user_id = v_reader and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
  ),
  conn as (
    select distinct on (lower(c.external_account_id))
      lower(c.external_account_id) as account, c.id, c.provider, c.status, c.last_sync_at, c.last_error, c.last_error_stream
    from core.connections c
    where c.lane_id = p_lane and c.owner_user_id = v_reader and c.provider in ('google', 'microsoft') and c.status <> 'disconnected'
    order by lower(c.external_account_id), (c.status = 'active') desc, c.updated_at desc
  ),
  streams as (
    select 'mail'::text as stream where v_mail
    union all
    select 'calendar'::text where v_cal
  )
  select
    s.stream,
    a.account,
    k.id,
    k.provider,
    coalesce(k.status, 'not_connected'),
    a.account = any (v_boxes),
    -- T-270: the stream's own cursor time ONLY (the time the stream's sync stored its position). There is no fallback to the connection's last
    -- succeeded run: sync_runs has no stream column, so a calendar-only success made Mail read "synced, OK" before any mail was read.
    -- No cursor for the stream: null (the app shows "not synced yet").
    case when k.id is null then null else
      (select max(sc.updated_at) from core.sync_cursors sc where sc.connection_id = k.id and sc.lane_id = p_lane and sc.stream = s.stream)
    end,
    case
      when k.last_error is null then null
      -- T-238: an error of the other stream is not this row's error
      when k.last_error_stream is not null and k.last_error_stream <> s.stream then null
      when (k.last_error ->> 'kind') ~ '^[a-z][a-z_]{0,40}$' then k.last_error ->> 'kind'
      else 'unknown'
    end
  from accounts a
  cross join streams s
  left join conn k on k.account = a.account
  order by s.stream desc, a.account;
  -- Access but nothing connected: one row per visible stream says so (never "no rows" = "no access").
  if not found then
    return query
    select x.stream, null::text, null::uuid, null::text, 'not_configured'::text, false, null::timestamptz, null::text
    from (select 'mail'::text as stream where v_mail union all select 'calendar'::text where v_cal) x
    order by x.stream desc;
  end if;
end;
$$;
comment on function core.briefing_coverage(text, uuid) is
  'Home briefing (T-231a; T-247: the reader''s own accounts only; T-270: last sync is the stream''s own cursor time, null before that stream has synced): coverage per (stream, account): status, last sync, connector error kind only. p_owner is used only when the caller is service_role (the job path). Definer only to read connection health; answers callers holding own_mail at AAL2.';
revoke all on function core.briefing_coverage(text, uuid) from public, anon;
grant execute on function core.briefing_coverage(text, uuid) to authenticated, service_role;


create or replace function brief.briefing_sources_newer(p_lane text, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from core.connections c
    where c.lane_id = p_lane and c.owner_user_id = p_uid and c.status <> 'disconnected'
      -- the mail stream (only a mail provider has one, so no provider is named here) has stored its position (the first mail sync is done)
      and exists (select 1 from core.sync_cursors sc where sc.connection_id = c.id and sc.lane_id = p_lane and sc.stream = 'mail')
      -- and the connection's first succeeded sync finished after the newest good summary was prepared
      and (select min(r.finished_at) from core.sync_runs r where r.connection_id = c.id and r.lane_id = p_lane and r.status = 'succeeded' and r.job = 'sync')
          > (select max(b.prepared_at) from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = p_uid and b.status <> 'failed')
  );
$$;
comment on function brief.briefing_sources_newer(text, uuid) is
  'T-270: true when a live own mail/calendar connection of the user has a mail cursor and its first succeeded sync finished after the user''s newest non-failed briefing was prepared. A user with no briefing: false (nothing to renew; the auto claim is stale anyway). Definer helper; no grants.';
revoke all on function brief.briefing_sources_newer(text, uuid) from public, anon, authenticated, service_role;

create or replace function core.briefing_sources_newer(p_lane text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' or p_lane is null or not core.may_brief(v_uid, p_lane) then
    return false;
  end if;
  return brief.briefing_sources_newer(p_lane, v_uid);
end;
$$;
comment on function core.briefing_sources_newer(text) is
  'T-270: for a member holding own_mail (AAL2): the newest summary was prepared before one of their own connections first synced (Home then asks for one renewal). False for anyone else.';
revoke all on function core.briefing_sources_newer(text) from public, anon, service_role;
grant execute on function core.briefing_sources_newer(text) to authenticated;

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
                                   and b.prepared_at > pg_catalog.clock_timestamp() - interval '3 hours')
                                   -- T-270: a summary made before the user's newest connection first synced is stale, whatever its age.
                                   and not brief.briefing_sources_newer(p_lane, p_uid) then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'not_stale');
    end if;
    if exists (select 1 from brief.briefing_runs r where r.lane_id = p_lane and r.owner_user_id = p_uid and r.status = 'running' and r.started_at > pg_catalog.clock_timestamp() - interval '2 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'running');
    end if;
    -- Every claim of the day counts, lost ones too (T-235 part 1 re-check H1): a released or crashed run may already have
    -- paid for a model call, so the 6 per owner and day stay a hard bound.
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
  'T-235: claims one briefing run: stale (auto: latest briefing older than 3 h, or made before the user''s newest connection first synced, T-270), one running per owner (2 min), 6 per owner and New York day (every claim counts, lost ones too), Regenerate once per 30 min, 10 min pause after an auto/regenerate/manual attempt. A schedule claim is never gated by the cap; a running one is reused, a finished day answers gate done, a failed retry adds a counted claim. Returns {id, gate}. Definer wrappers only.';
revoke all on function brief.briefing_claim(text, uuid, text) from public, anon, authenticated, service_role;
