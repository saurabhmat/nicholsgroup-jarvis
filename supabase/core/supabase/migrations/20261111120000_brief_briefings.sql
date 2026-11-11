-- Daily briefing store (T-231c, refines T-162): brief.briefings holds one prepared briefing per run for one owner in one
-- lane: the composed lines (AI text derived from mail metadata and live-read bodies; bodies themselves are never stored,
-- rule 6), coverage at run time, source references (provider ids, links and subjects only) and the review window.
-- Reply-draft text (T-231d) is kept only when the lane policy allows outbound drafts (D-19); the app enforces it and the
-- table refuses `replies` text otherwise (trigger).
--
-- Read: AAL2 + the caller holds the briefing view on the lane + the row is the caller's own (owner_user_id = auth.uid()).
--   Home reads through core.briefing_latest (invoker, so RLS applies). Write: the scheduled job through core.briefing_save
--   (service_role only); "Run now" through core.briefing_save_own (definer: the caller saves only their own, AAL2 + owner
--   + briefing view + 2-minute cooldown), so request code never holds a service client.
-- Retention: brief.briefings_purge(p_lane, p_keep) (service_role; default 30 days, floor 1, cap the lane policy's
--   retention_days), registered with the retention job.
-- Tests: 282_brief_briefings.test.sql (incl. cross-lane, cross-user, AAL1 and no-view denial).

create schema brief;
revoke all on schema brief from public, anon;
grant usage on schema brief to authenticated, service_role;
alter default privileges in schema brief revoke execute on functions from public;

create table brief.briefings (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  owner_user_id uuid not null references core.users (id) on update restrict on delete cascade,
  trigger text not null check (trigger in ('manual', 'schedule')),
  status text not null check (status in ('ready', 'partial', 'failed')),
  prepared_at timestamptz not null default pg_catalog.clock_timestamp(),
  window_from timestamptz not null,
  window_to timestamptz not null,
  -- {lines[], attention[], deadlines[], priorities[], replies[], notes[]}: shape checked by the app (zod), size here.
  content jsonb not null default '{}' check (pg_catalog.jsonb_typeof(content) = 'object' and pg_catalog.octet_length(content::text) <= 65536),
  coverage jsonb not null default '[]' check (pg_catalog.jsonb_typeof(coverage) = 'array' and pg_catalog.octet_length(coverage::text) <= 16384),
  source_refs jsonb not null default '[]' check (pg_catalog.jsonb_typeof(source_refs) = 'array' and pg_catalog.octet_length(source_refs::text) <= 32768),
  model text check (length(model) between 1 and 128),
  created_at timestamptz not null default now(),
  check (window_to > window_from)
);
comment on table brief.briefings is
  'Prepared daily briefings (T-231c): composed text, coverage, source refs and review window; no mail bodies. Owner-only read; service_role writes.';
create index briefings_lane_owner_idx on brief.briefings (lane_id, owner_user_id, prepared_at desc);
create index briefings_owner_idx on brief.briefings (owner_user_id);

-- Reply drafts are outbound composed text: only while the lane policy stores outbound drafts (D-19).
create function brief.briefings_guard() returns trigger
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
  -- Only a lane owner who holds the briefing view gets a briefing (owner roles carry it; checked again here so a direct
  -- service_role insert cannot put a briefing on another member's Home).
  if not core.has_lane_role(new.owner_user_id, new.lane_id, array['owner'])
     or not (new.lane_id = any (core.allowed_lanes(new.owner_user_id, 'briefing'))) then
    raise exception 'brief.briefings: the owner does not hold the briefing view in this lane' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function brief.briefings_guard() from public, anon, authenticated;
-- Insert only: no role may update a briefing (service_role has select, insert, delete).
create trigger briefings_guard before insert on brief.briefings
  for each row execute function brief.briefings_guard();

alter table brief.briefings enable row level security;
create policy briefings_select on brief.briefings
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'briefing'))::text[])
    and owner_user_id = (select auth.uid())
  );
revoke all on brief.briefings from public, anon, authenticated, service_role;
grant select on brief.briefings to authenticated;
grant select, insert, delete on brief.briefings to service_role;

-- ---------------------------------------------------------------- reads and writes through core (the exposed schema)
create function core.briefing_latest(p_lane text)
returns table (id uuid, trigger text, status text, prepared_at timestamptz, window_from timestamptz, window_to timestamptz,
               content jsonb, coverage jsonb, source_refs jsonb, model text, last_failed_at timestamptz, last_run_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  -- The newest briefing that was prepared (a failed attempt never hides the last good one), plus when the newest failed
  -- attempt after it happened (Home says so) and the newest attempt of any kind (the Run-now cooldown).
  return query
  with mine as (
    select b.* from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = auth.uid()
  ), good as (
    select m.* from mine m where m.status <> 'failed' order by m.prepared_at desc limit 1
  )
  select g.id, g.trigger, g.status, g.prepared_at, g.window_from, g.window_to, g.content, g.coverage, g.source_refs, g.model,
         (select max(f.prepared_at) from mine f where f.status = 'failed' and f.prepared_at > coalesce(g.prepared_at, '-infinity')),
         (select max(a.prepared_at) from mine a)
  from (select 1) one
  left join good g on true
  where exists (select 1 from mine);
end;
$$;
comment on function core.briefing_latest(text) is 'Home (T-231c): the caller''s latest non-failed briefing in a lane (id null when every attempt failed), the newest failed attempt after it and the newest attempt. Invoker: RLS on brief.briefings applies.';
revoke all on function core.briefing_latest(text) from public, anon;
grant execute on function core.briefing_latest(text) to authenticated, service_role;

create function core.briefing_save(p_lane text, p_owner uuid, p_trigger text, p_status text, p_window_from timestamptz,
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
  return v_id;
end;
$$;
comment on function core.briefing_save(text, uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) is
  'T-231c: stores one prepared briefing. service_role only (the job and the Run-now route after its own session check).';
revoke all on function core.briefing_save(text, uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function core.briefing_save(text, uuid, text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) to service_role;

-- "Run now" (request path): the signed-in owner saves their own briefing. Definer, so request code holds no service
-- client: the owner is always auth.uid(), AAL2 is required, the caller must be a lane owner with the briefing view, and
-- one attempt per owner and lane every 2 minutes (also enforced here, not only in the app).
create function core.briefing_save_own(p_lane text, p_status text, p_window_from timestamptz, p_window_to timestamptz,
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
  if exists (select 1 from brief.briefings b where b.lane_id = p_lane and b.owner_user_id = v_uid
             and b.prepared_at > pg_catalog.clock_timestamp() - interval '2 minutes') then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  insert into brief.briefings (lane_id, owner_user_id, trigger, status, window_from, window_to, content, coverage, source_refs, model)
  values (p_lane, v_uid, 'manual', p_status, p_window_from, p_window_to, coalesce(p_content, '{}'), coalesce(p_coverage, '[]'),
          coalesce(p_source_refs, '[]'), p_model)
  returning brief.briefings.id into v_id;
  return v_id;
end;
$$;
comment on function core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) is
  'T-231c Run now: the signed-in lane owner (AAL2, briefing view) saves their own briefing; 2-minute cooldown.';
revoke all on function core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) from public, anon;
grant execute on function core.briefing_save_own(text, text, timestamptz, timestamptz, jsonb, jsonb, jsonb, text) to authenticated;

-- Retention: a lane's briefings older than the keep interval (default 30 days; floor 1 day; never more than the lane
-- policy's retention_days). Refuses a disabled or unknown lane.
create function brief.briefings_purge(p_lane text, p_keep interval default interval '30 days')
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_policy interval;
  v_keep interval;
  v_n integer;
begin
  if p_lane is null or p_keep is null then
    raise exception 'lane and keep are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '22023';
  end if;
  select pg_catalog.make_interval(days => lp.retention_days) into v_policy from core.lane_policies lp where lp.lane_id = p_lane;
  if v_policy is null then
    raise exception 'no lane policy for this lane' using errcode = '22023';
  end if;
  if p_keep < interval '1 day' then
    raise exception 'keep at least 1 day of briefings' using errcode = '22023';
  end if;
  v_keep := least(p_keep, v_policy);
  delete from brief.briefings b where b.lane_id = p_lane and b.prepared_at < pg_catalog.now() - v_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function brief.briefings_purge(text, interval) from public, anon, authenticated;
grant execute on function brief.briefings_purge(text, interval) to service_role;
create function core.briefings_purge(p_lane text, p_keep_days integer)
returns integer
language sql
security invoker
set search_path = ''
as $$ select brief.briefings_purge(p_lane, pg_catalog.make_interval(days => p_keep_days)); $$;
revoke all on function core.briefings_purge(text, integer) from public, anon, authenticated;
grant execute on function core.briefings_purge(text, integer) to service_role;
