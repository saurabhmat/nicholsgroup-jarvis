-- GovCon news card (T-234 part 4, brings T-218 forward). Re-runnable: create if not exists, create or replace, guarded swaps.
--
-- 1. The `web` category. lane_policies.llm_allowed_categories now accepts 'web' (every earlier category is kept). A lane gets
--    it only by a human step; the news job and every manual refresh refuse a lane without it. 'web' is NOT an assistant tool
--    category: core.ai_tool_gate keeps refusing it ('invalid category') and core.ai_chat_turn does not count it (like
--    brain_import), so it neither opens the chat nor is offered to it.
-- 2. brief.news_digests: one row per fetch attempt (append-only apart from the single pending -> final step). The model call
--    happens between core.news_begin_* (which reserves the worst-case cost, enforces the lane gates, the monthly cap, the
--    scheduled-attempt rules and the owner-refresh limit, all under an advisory lock) and core.news_finish* (which stores the
--    items and the cost estimate). A crashed call keeps its reserved cost (conservative) and is closed as failed/timed_out.
--    Scheduled attempts: a failed or lost morning fetch does not block the day. A scheduled attempt is allowed while today has no
--    ok/partial/pending digest, fewer than 3 scheduled failures and the last scheduled attempt started at least 30 minutes ago.
--    Owner refresh: one ok/partial refresh per hour; after a FAILED refresh one retry is allowed 5 minutes later.
--    news_begin_* RETURN a gate code ({id, gate}) instead of raising, so the closing of a lost attempt commits even when the
--    reserve is then refused. The owner's refresh cannot under-report its spend: news_finish_own keeps the reserve as a floor.
--    Items are display data derived from untrusted web results (rule 9): the app validates them (grounded https links); the
--    database re-checks shape, https and size. News is not financial data: amounts stay as the source wrote them.
-- 3. Read: AAL2 + the caller holds the 'briefing' view in the lane (the Home view; owners, finance operators and viewers),
--    through core.news_latest (invoker, RLS applies). admin_technical has no content views and reads only core.news_spend
--    (spend and status, no items). Writes: the job (service_role) and the owner's refresh through definer wrappers.
-- 4. Retention: brief.news_purge (default 30 days, floor 1 day, never above the lane policy's retention_days, and never
--    deleting rows of the current New York month, so the month-to-date spend ledger stays whole).
-- Tests: 305_news.test.sql (RLS incl. cross-lane, AAL1, no-view, anon; refresh rate limit; cap; category constraint; grants).

-- ---------------------------------------------------------------- the web category
alter table core.lane_policies drop constraint if exists lane_policies_llm_allowed_categories_check;
alter table core.lane_policies add constraint lane_policies_llm_allowed_categories_check
  check (llm_allowed_categories <@ array['email', 'calendar', 'docs', 'finance', 'finance_summary', 'tasks', 'brain_import', 'web']::text[]);

-- The chat gate counts tool categories only: a copy of the latest definition (20261109100000_brain_import.sql) that also leaves 'web' out.
create or replace function core.ai_chat_turn(p_lane text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_categories text[];
  v_limit integer := 6;
  v_raw text;
  v_window timestamptz := pg_catalog.date_trunc('minute', now());
  v_turns integer;
begin
  if p_lane is null or p_lane !~ '^[A-Z]{1,8}$' then
    raise exception 'invalid lane' using errcode = '22023';
  end if;
  if v_uid is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_required', 'categories', '[]'::jsonb);
  end if;
  select m.role into v_role
  from core.memberships m join core.lanes l on l.code = m.lane_id
  where m.user_id = v_uid and m.lane_id = p_lane and l.enabled;
  if not found or v_role not in ('owner', 'finance_operator') or not (p_lane = any (core.allowed_lanes(v_uid, 'assistant'))) then
    return jsonb_build_object('allowed', false, 'reason', 'forbidden', 'categories', '[]'::jsonb);
  end if;
  -- 'brain_import' and 'web' are not assistant tool categories, so they neither open the chat nor are offered to it.
  select coalesce(array(select c from pg_catalog.unnest(lp.llm_allowed_categories) c where c not in ('brain_import', 'web')), '{}') into v_categories
  from core.lane_policies lp where lp.lane_id = p_lane;
  if coalesce(cardinality(v_categories), 0) = 0 then
    return jsonb_build_object('allowed', false, 'reason', 'forbidden', 'categories', '[]'::jsonb);
  end if;

  select c.config -> 'assistant' ->> 'turns_per_minute' into v_raw
  from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1;
  if v_raw ~ '^[0-9]{1,2}$' and v_raw::integer between 1 and 60 then
    v_limit := v_raw::integer;
  end if;
  delete from core.ai_chat_rate r where r.lane_id = p_lane and r.user_id = v_uid and r.window_start < v_window;
  insert into core.ai_chat_rate as r (lane_id, user_id, window_start, turns)
  values (p_lane, v_uid, v_window, 1)
  on conflict (lane_id, user_id, window_start) do update set turns = r.turns + 1 where r.turns < v_limit
  returning r.turns into v_turns;
  if v_turns is null then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'categories', '[]'::jsonb);
  end if;
  return jsonb_build_object('allowed', true, 'reason', null, 'categories', to_jsonb(v_categories));
end;
$$;
comment on function core.ai_chat_turn(text) is
  'Assistant chat route gate (T-105): aal2, owner/finance_operator with the assistant view in an enabled lane, non-empty tool categories (brain_import and web do not count), per-minute turn limit. Returns {allowed, reason, categories}.';
revoke all on function core.ai_chat_turn(text) from public, anon, service_role;
grant execute on function core.ai_chat_turn(text) to authenticated;

-- ---------------------------------------------------------------- the digests
create table if not exists brief.news_digests (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  -- The New York date the attempt started.
  day date not null default ((pg_catalog.clock_timestamp() at time zone 'America/New_York')::date),
  trigger text not null check (trigger in ('schedule', 'refresh')),
  requested_by uuid references core.users (id) on update restrict on delete set null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'partial', 'failed')),
  -- A fixed code (letters, digits, underscore): never a vendor message.
  failure_code text check (failure_code is null or failure_code ~ '^[a-z][a-z0-9_]{0,39}$'),
  -- [{headline, why, source_name, source_url (https), published_at, citations[]}], at most 6; shape re-checked by the guard.
  items jsonb not null default '[]' check (pg_catalog.jsonb_typeof(items) = 'array' and pg_catalog.jsonb_array_length(items) <= 6 and pg_catalog.octet_length(items::text) <= 32768),
  searches integer not null default 0 check (searches between 0 and 50),
  -- USD estimate (searches x lane price + tokens x lane prices). While pending it holds the reserved worst case.
  est_cost numeric(18,2) not null default 0 check (est_cost between 0 and 1000),
  -- The worst case reserved before the model call (fixed at insert). news_finish_own never stores less than this for a refresh.
  reserved numeric(18,2) not null default 0 check (reserved between 0 and 100),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  fetched_at timestamptz,
  check ((status = 'pending') = (fetched_at is null)),
  check ((status = 'failed') = (failure_code is not null))
);
comment on table brief.news_digests is
  'GovCon news digests (T-234 part 4): one row per fetch attempt; items are display data from untrusted web results, validated by the app. Members with the briefing view read; the job and the owner refresh write through definer functions.';
alter table brief.news_digests add column if not exists reserved numeric(18,2) not null default 0 check (reserved between 0 and 100);
create index if not exists news_digests_lane_created_idx on brief.news_digests (lane_id, created_at desc);
create index if not exists news_digests_lane_day_idx on brief.news_digests (lane_id, day);

create or replace function brief.news_digests_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_el jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or jsonb_array_length(new.items) <> 0 then
      raise exception 'brief.news_digests: a digest starts pending and empty' using errcode = '23514';
    end if;
    if not exists (select 1 from core.lanes l where l.code = new.lane_id and l.enabled) then
      raise exception 'brief.news_digests: lane is not enabled' using errcode = '22023';
    end if;
    if new.trigger = 'refresh' and (new.requested_by is null or not core.has_lane_role(new.requested_by, new.lane_id, array['owner'])
       or not (new.lane_id = any (core.allowed_lanes(new.requested_by, 'briefing')))) then
      raise exception 'brief.news_digests: a refresh needs a lane owner with the briefing view' using errcode = '23514';
    end if;
    return new;
  end if;
  -- UPDATE: the single pending -> final step, nothing else.
  if old.status <> 'pending' or new.status = 'pending' then
    raise exception 'brief.news_digests: a finished digest is final' using errcode = '23514';
  end if;
  if new.id <> old.id or new.lane_id <> old.lane_id or new.trigger <> old.trigger or new.day <> old.day or new.created_at <> old.created_at
     or new.requested_by is distinct from old.requested_by or new.reserved <> old.reserved then
    raise exception 'brief.news_digests: identity columns are fixed' using errcode = '23514';
  end if;
  -- The refresh cost floor also lives in the table guard, not only in news_finish_own: no later writer can book an owner
  -- refresh below what was reserved for it (part 4 re-check L2).
  if new.trigger = 'refresh' and new.est_cost < old.reserved then
    raise exception 'brief.news_digests: a refresh is never booked below its reserve' using errcode = '23514';
  end if;
  if new.status in ('ok', 'partial') and jsonb_array_length(new.items) = 0 then
    raise exception 'brief.news_digests: an ok digest needs items' using errcode = '23514';
  end if;
  if new.status = 'failed' and jsonb_array_length(new.items) <> 0 then
    raise exception 'brief.news_digests: a failed digest has no items' using errcode = '23514';
  end if;
  for v_el in select e from jsonb_array_elements(new.items) e loop
    if jsonb_typeof(v_el) <> 'object'
       or coalesce(jsonb_typeof(v_el -> 'headline'), '') <> 'string' or length(v_el ->> 'headline') not between 1 and 300
       or coalesce(jsonb_typeof(v_el -> 'why'), '') <> 'string' or length(v_el ->> 'why') not between 1 and 400
       or coalesce(jsonb_typeof(v_el -> 'source_name'), '') <> 'string' or length(v_el ->> 'source_name') not between 1 and 120
       or coalesce(jsonb_typeof(v_el -> 'source_url'), '') <> 'string' or (v_el ->> 'source_url') !~ '^https://[^[:space:]<>"]+$' or length(v_el ->> 'source_url') not between 12 and 2048
       -- The authority (host part) carries no user-info ('@'), no IP literal ('[...]') and is not a bare IPv4 address.
       or coalesce(pg_catalog.substring(v_el ->> 'source_url', '^https://([^/?#]*)'), '@') ~ '@|\[|\]'
       or coalesce(pg_catalog.substring(v_el ->> 'source_url', '^https://([^/?#]*)'), '@') ~ '^[0-9.]+(:[0-9]+)?$'
       or (v_el ? 'published_at' and jsonb_typeof(v_el -> 'published_at') not in ('string', 'null'))
       or (v_el ? 'preferred' and jsonb_typeof(v_el -> 'preferred') <> 'boolean')
       or (v_el ? 'citations' and (jsonb_typeof(v_el -> 'citations') <> 'array' or jsonb_array_length(v_el -> 'citations') > 6
            or exists (select 1 from jsonb_array_elements(v_el -> 'citations') c where jsonb_typeof(c) <> 'string' or length(c #>> '{}') > 2048))) then
      raise exception 'brief.news_digests: an item is malformed (headline, why, source_name, https source_url)' using errcode = '23514';
    end if;
  end loop;
  new.fetched_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;
revoke all on function brief.news_digests_guard() from public, anon, authenticated, service_role;
drop trigger if exists news_digests_guard on brief.news_digests;
create trigger news_digests_guard before insert or update on brief.news_digests
  for each row execute function brief.news_digests_guard();

alter table brief.news_digests enable row level security;
drop policy if exists news_digests_select on brief.news_digests;
create policy news_digests_select on brief.news_digests
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'briefing'))::text[])
  );
revoke all on brief.news_digests from public, anon, authenticated, service_role;
grant select on brief.news_digests to authenticated;
grant select, delete on brief.news_digests to service_role;
grant update (status, failure_code, items, searches, est_cost) on brief.news_digests to service_role;

-- First instant of the current New York month (the spend ledger's window).
create or replace function brief.news_month_start() returns timestamptz
language sql
stable
set search_path = ''
as $$ select pg_catalog.date_trunc('month', pg_catalog.clock_timestamp() at time zone 'America/New_York') at time zone 'America/New_York'; $$;
revoke all on function brief.news_month_start() from public, anon, authenticated;
grant execute on function brief.news_month_start() to service_role;

-- The lane's monthly cap (USD) from lane_config news.monthly_cap_usd; 20 when unset or unreadable. Never taken from a caller.
create or replace function brief.news_cap(p_lane text) returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_cap numeric := 20;
begin
  select c.config -> 'news' ->> 'monthly_cap_usd' into v_raw from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1;
  if v_raw ~ '^[0-9]{1,4}(\.[0-9]{1,2})?$' and v_raw::numeric between 1 and 1000 then
    v_cap := v_raw::numeric;
  end if;
  return v_cap;
end;
$$;
revoke all on function brief.news_cap(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- reserve (the gates, before any model call)
-- Returns {"id": <uuid>, "gate": null} for a new pending row (its est_cost and reserved are the reserve), or {"id": null, "gate": <code>}
-- for a refusal. It does NOT raise for a refusal: the closing of a lost attempt (below) must commit even when the reserve is then refused.
-- Gate codes: not_configured (no 'web' category or news.enabled is not true), already_fetched (scheduled: today already has an
-- ok/partial/pending digest), attempts_exhausted (scheduled: 3 scheduled failures today), retry_later (scheduled: the last scheduled
-- attempt started less than 30 minutes ago), busy (an attempt started in the last 10 minutes is still pending), rate_limited (owner
-- refresh: an ok/partial refresh in the last hour, or any refresh in the last 5 minutes), cap_reached (month-to-date + p_reserve >
-- lane_config news.monthly_cap_usd, default 20). The cap comes from the lane config here, never from the caller. Invalid arguments
-- and a disabled lane still raise (22023).
drop function if exists core.news_begin_scheduled(text, numeric);
drop function if exists core.news_begin_refresh(text, numeric);
drop function if exists brief.news_reserve(text, text, uuid, numeric);
create function brief.news_reserve(p_lane text, p_trigger text, p_user uuid, p_reserve numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.clock_timestamp() at time zone 'America/New_York')::date;
  v_cfg jsonb;
  v_cap numeric;
  v_spend numeric;
  v_id uuid;
  v_failures integer;
begin
  if p_lane is null or p_lane !~ '^[A-Z]{1,8}$' or p_trigger not in ('schedule', 'refresh') or p_reserve is null or p_reserve <= 0 or p_reserve > 100 then
    raise exception 'invalid arguments' using errcode = '22023';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brief.news_digests:' || p_lane, 0));
  if not coalesce((select 'web' = any (lp.llm_allowed_categories) from core.lane_policies lp where lp.lane_id = p_lane), false) then
    return pg_catalog.jsonb_build_object('id', null, 'gate', 'not_configured');
  end if;
  select c.config -> 'news' into v_cfg from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1;
  if coalesce(v_cfg ->> 'enabled', 'false') <> 'true' then
    return pg_catalog.jsonb_build_object('id', null, 'gate', 'not_configured');
  end if;
  v_cap := brief.news_cap(p_lane);
  -- A pending attempt older than 10 minutes was lost (crash, timeout): close it as failed, keeping its reserved cost. This is a
  -- committed step: every refusal below returns normally instead of raising.
  update brief.news_digests d set status = 'failed', failure_code = 'timed_out'
  where d.lane_id = p_lane and d.status = 'pending' and d.created_at < pg_catalog.clock_timestamp() - interval '10 minutes';
  if p_trigger = 'schedule' then
    if exists (select 1 from brief.news_digests d where d.lane_id = p_lane and d.day = v_today and d.status in ('ok', 'partial', 'pending')) then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'already_fetched');
    end if;
    select count(*) into v_failures from brief.news_digests d where d.lane_id = p_lane and d.day = v_today and d.trigger = 'schedule' and d.status = 'failed';
    if v_failures >= 3 then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'attempts_exhausted');
    end if;
    if exists (select 1 from brief.news_digests d where d.lane_id = p_lane and d.day = v_today and d.trigger = 'schedule'
               and d.created_at > pg_catalog.clock_timestamp() - interval '30 minutes') then
      return pg_catalog.jsonb_build_object('id', null, 'gate', 'retry_later');
    end if;
  end if;
  if exists (select 1 from brief.news_digests d where d.lane_id = p_lane and d.status = 'pending') then
    return pg_catalog.jsonb_build_object('id', null, 'gate', 'busy');
  end if;
  if p_trigger = 'refresh' and exists (
       select 1 from brief.news_digests d where d.lane_id = p_lane and d.trigger = 'refresh'
       and ((d.status in ('ok', 'partial') and d.created_at > pg_catalog.clock_timestamp() - interval '1 hour')
            or d.created_at > pg_catalog.clock_timestamp() - interval '5 minutes')) then
    return pg_catalog.jsonb_build_object('id', null, 'gate', 'rate_limited');
  end if;
  select coalesce(sum(d.est_cost), 0) into v_spend from brief.news_digests d where d.lane_id = p_lane and d.created_at >= brief.news_month_start();
  if v_spend + p_reserve > v_cap then
    return pg_catalog.jsonb_build_object('id', null, 'gate', 'cap_reached');
  end if;
  insert into brief.news_digests (lane_id, trigger, requested_by, est_cost, reserved) values (p_lane, p_trigger, p_user, p_reserve, p_reserve) returning id into v_id;
  return pg_catalog.jsonb_build_object('id', v_id, 'gate', null);
end;
$$;
comment on function brief.news_reserve(text, text, uuid, numeric) is
  'T-234 part 4: lane gates (web category, news.enabled), scheduled retry rules (3 failures, 30 min apart), refresh limit (1 ok per hour, retry 5 min after a failure), monthly cap from lane_config; reserves the worst-case cost. Returns {id, gate}. service_role and the definer wrappers only.';
revoke all on function brief.news_reserve(text, text, uuid, numeric) from public, anon, authenticated;
grant execute on function brief.news_reserve(text, text, uuid, numeric) to service_role;

-- The job (service_role).
create function core.news_begin_scheduled(p_lane text, p_reserve numeric)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select brief.news_reserve(p_lane, 'schedule', null, p_reserve); $$;
revoke all on function core.news_begin_scheduled(text, numeric) from public, anon, authenticated;
grant execute on function core.news_begin_scheduled(text, numeric) to service_role;

create or replace function core.news_finish(p_lane text, p_id uuid, p_status text, p_failure_code text, p_items jsonb, p_searches integer, p_est_cost numeric)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update brief.news_digests d set status = p_status, failure_code = p_failure_code, items = coalesce(p_items, '[]'), searches = coalesce(p_searches, 0), est_cost = coalesce(p_est_cost, 0)
  where d.id = p_id and d.lane_id = p_lane and d.trigger = 'schedule' and d.status = 'pending';
  if not found then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function core.news_finish(text, uuid, text, text, jsonb, integer, numeric) from public, anon, authenticated;
grant execute on function core.news_finish(text, uuid, text, text, jsonb, integer, numeric) to service_role;

-- The owner's Refresh: aal2 + lane owner + briefing view; the refresh limit and the cap are enforced by brief.news_reserve (returns {id, gate}).
create function core.news_begin_refresh(p_lane text, p_reserve numeric)
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
  return brief.news_reserve(p_lane, 'refresh', v_uid, p_reserve);
end;
$$;
revoke all on function core.news_begin_refresh(text, numeric) from public, anon, service_role;
grant execute on function core.news_begin_refresh(text, numeric) to authenticated;

create or replace function core.news_finish_own(p_lane text, p_id uuid, p_status text, p_failure_code text, p_items jsonb, p_searches integer, p_est_cost numeric)
returns void
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
  if p_est_cost is not null and (p_est_cost < 0 or p_est_cost > 1000) then
    raise exception 'invalid cost' using errcode = '22023';
  end if;
  -- The owner cannot under-report: the stored cost is never below what was reserved for this attempt.
  update brief.news_digests d set status = p_status, failure_code = p_failure_code, items = coalesce(p_items, '[]'), searches = coalesce(p_searches, 0),
         est_cost = greatest(d.reserved, coalesce(p_est_cost, 0))
  where d.id = p_id and d.lane_id = p_lane and d.trigger = 'refresh' and d.requested_by = v_uid and d.status = 'pending';
  if not found then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function core.news_finish_own(text, uuid, text, text, jsonb, integer, numeric) from public, anon, service_role;
grant execute on function core.news_finish_own(text, uuid, text, text, jsonb, integer, numeric) to authenticated;

-- ---------------------------------------------------------------- reads
-- Home: the newest ok/partial digest fetched in the last 30 hours (items), the newest failure after it, the time from which the
-- owner may refresh again (an ok/partial refresh + 1 hour, or any refresh + 5 minutes; null when allowed now) and whether an
-- attempt is in flight. No row when the lane has no attempt at all.
drop function if exists core.news_latest(text);
create function core.news_latest(p_lane text)
returns table (id uuid, day date, trigger text, status text, items jsonb, fetched_at timestamptz, searches integer,
               last_failed_at timestamptz, last_failure_code text, next_refresh_at timestamptz, pending_since timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  return query
  with mine as (select d.* from brief.news_digests d where d.lane_id = p_lane),
  good as (
    select m.* from mine m where m.status in ('ok', 'partial') and m.fetched_at > pg_catalog.clock_timestamp() - interval '30 hours'
    order by m.fetched_at desc limit 1
  ),
  bad as (
    select m.fetched_at, m.failure_code from mine m
    where m.status = 'failed' and m.fetched_at > coalesce((select g.fetched_at from good g), '-infinity')
    order by m.fetched_at desc limit 1
  )
  select g.id, g.day, g.trigger, g.status, coalesce(g.items, '[]'::jsonb), g.fetched_at, g.searches,
         (select b.fetched_at from bad b), (select b.failure_code from bad b),
         (select w.at from (select greatest((select max(r.created_at) + interval '1 hour' from mine r where r.trigger = 'refresh' and r.status in ('ok', 'partial')),
                                            (select max(r.created_at) + interval '5 minutes' from mine r where r.trigger = 'refresh')) as at) w
          where w.at > pg_catalog.clock_timestamp()),
         (select max(p.created_at) from mine p where p.status = 'pending' and p.created_at > pg_catalog.clock_timestamp() - interval '10 minutes')
  from (select 1) one
  left join good g on true
  where exists (select 1 from mine);
end;
$$;
comment on function core.news_latest(text) is 'Home GovCon news: the newest ok digest (30 h), the newest failure after it, when the owner may refresh again and the in-flight flag. Invoker: RLS on brief.news_digests applies.';
revoke all on function core.news_latest(text) from public, anon;
grant execute on function core.news_latest(text) to authenticated, service_role;

-- Whether news is configured for the lane (web category AND news.enabled): one boolean for any member holding the briefing view,
-- so Home can say "News not configured" without exposing lane_policies or lane_config.
create or replace function core.news_enabled(p_lane text) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' or p_lane is null
     or not (p_lane = any (core.allowed_lanes(v_uid, 'briefing'))) then
    return false;
  end if;
  return coalesce((select 'web' = any (lp.llm_allowed_categories) from core.lane_policies lp where lp.lane_id = p_lane), false)
     and coalesce((select c.config -> 'news' ->> 'enabled' from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1), 'false') = 'true';
end;
$$;
comment on function core.news_enabled(text) is 'T-234 part 4: is GovCon news configured (web category + news.enabled) for the lane; boolean only; aal2 + briefing view, else false.';
revoke all on function core.news_enabled(text) from public, anon, service_role;
grant execute on function core.news_enabled(text) to authenticated;

-- Settings / Home budget: configuration state, spend against the cap and the last attempt (no items), for the lane owner and
-- admin_technical at aal2.
create or replace function core.news_spend(p_lane text)
returns table (web_allowed boolean, news_enabled boolean, cap_usd numeric, month_spend numeric, month_fetches integer,
               last_status text, last_failure_code text, last_fetch_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lane is null or not core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
  select coalesce((select 'web' = any (lp.llm_allowed_categories) from core.lane_policies lp where lp.lane_id = p_lane), false),
         coalesce((select c.config -> 'news' ->> 'enabled' from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1), 'false') = 'true',
         brief.news_cap(p_lane),
         coalesce((select sum(d.est_cost) from brief.news_digests d where d.lane_id = p_lane and d.created_at >= brief.news_month_start()), 0)::numeric,
         (select count(*)::integer from brief.news_digests d where d.lane_id = p_lane and d.created_at >= brief.news_month_start()),
         (select d.status from brief.news_digests d where d.lane_id = p_lane and d.status <> 'pending' order by d.fetched_at desc limit 1),
         (select d.failure_code from brief.news_digests d where d.lane_id = p_lane and d.status <> 'pending' order by d.fetched_at desc limit 1),
         (select d.fetched_at from brief.news_digests d where d.lane_id = p_lane and d.status <> 'pending' order by d.fetched_at desc limit 1);
end;
$$;
comment on function core.news_spend(text) is 'T-234 part 4: news configuration state, month-to-date spend estimate against the cap and the last attempt, for the lane owner or admin_technical (aal2). No items.';
revoke all on function core.news_spend(text) from public, anon, service_role;
grant execute on function core.news_spend(text) to authenticated;

-- ---------------------------------------------------------------- retention
create or replace function brief.news_purge(p_lane text, p_keep interval default interval '30 days')
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_policy interval;
  v_keep interval;
  v_cutoff timestamptz;
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
    raise exception 'keep at least 1 day of news' using errcode = '22023';
  end if;
  v_keep := least(p_keep, v_policy);
  -- Never delete this month's rows: they are the spend ledger the cap reads.
  v_cutoff := least(pg_catalog.now() - v_keep, brief.news_month_start());
  delete from brief.news_digests d where d.lane_id = p_lane and d.created_at < v_cutoff;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function brief.news_purge(text, interval) from public, anon, authenticated;
grant execute on function brief.news_purge(text, interval) to service_role;
create or replace function core.news_purge(p_lane text, p_keep_days integer)
returns integer
language sql
security invoker
set search_path = ''
as $$ select brief.news_purge(p_lane, pg_catalog.make_interval(days => p_keep_days)); $$;
revoke all on function core.news_purge(text, integer) from public, anon, authenticated;
grant execute on function core.news_purge(text, integer) to service_role;
