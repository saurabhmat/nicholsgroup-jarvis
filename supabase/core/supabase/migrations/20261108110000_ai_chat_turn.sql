-- T-105 security review (Nov 8, 2026): H1 the chat route must refuse callers without assistant access before any
-- model call; M1 chat turns need their own rate limit (each turn can make up to 6 model calls).
-- core.ai_chat_turn(p_lane) is the route's gate, for auth.uid() only: aal2, member of the enabled lane with role
-- owner or finance_operator (the same roles the tool gate accepts) and the 'assistant' view, a non-empty
-- llm_allowed_categories, then one turn from a per-minute budget (lane_config.assistant.turns_per_minute, default 6,
-- 1..60). Returns {allowed, reason, categories}. Also: core.ai_tool_categories is narrowed to the same roles (L3).

create table core.ai_chat_rate (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  user_id uuid not null references core.users (id) on delete cascade,
  window_start timestamptz not null,
  turns integer not null default 0 check (turns >= 0),
  primary key (lane_id, user_id, window_start)
);
comment on table core.ai_chat_rate is
  'Assistant chat-turn counter per lane, user and minute (T-105). Private: only core.ai_chat_turn() reads or writes it.';
alter table core.ai_chat_rate enable row level security;
revoke all on core.ai_chat_rate from public, anon, authenticated, service_role;

create function core.ai_chat_turn(p_lane text)
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
  select coalesce(lp.llm_allowed_categories, '{}') into v_categories from core.lane_policies lp where lp.lane_id = p_lane;
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
  'Assistant chat route gate (T-105): aal2, owner/finance_operator with the assistant view in an enabled lane, non-empty categories, per-minute turn limit. Returns {allowed, reason, categories}.';
revoke all on function core.ai_chat_turn(text) from public, anon, service_role;
grant execute on function core.ai_chat_turn(text) to authenticated;

-- L3: the page's category lookup admits exactly the roles the gates accept.
create or replace function core.ai_tool_categories(p_lane text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select lp.llm_allowed_categories
    from core.lane_policies lp
    join core.memberships m on m.lane_id = lp.lane_id and m.user_id = (select auth.uid())
    where lp.lane_id = p_lane
      and coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
      and m.role in ('owner', 'finance_operator')
      and p_lane = any (core.allowed_lanes((select auth.uid()), 'assistant'))
  ), '{}'::text[]);
$$;
