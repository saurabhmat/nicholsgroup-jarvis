-- T-101: assistant tool policy gate (docs/specs/assistant.md §3, §4).
-- core.ai_tool_gate() answers one question for the CALLER (auth.uid() at aal2): may this user run a tool of this
-- category and required view in this lane right now? Checks, in order: aal2 session, membership and role, lane
-- enabled, the lane policy's llm_allowed_categories, the 'assistant' view plus the tool's required view, then the
-- rate limit (consumes one call). It returns a reason code, never data. Definer because a finance_operator may not read
-- core.lane_policies (owner/admin view) and the rate table is private. The TypeScript gate (packages/ai) calls it with
-- the user's own client, then validates arguments, runs the tool and audits the call.
-- The category and view come from the server-side tool descriptor, never from model output.

-- ---------------------------------------------------------------- rate counter (private)
create table core.ai_tool_rate (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  user_id uuid not null references core.users (id) on delete cascade,
  window_start timestamptz not null,
  calls integer not null default 0 check (calls >= 0),
  primary key (lane_id, user_id, window_start)
);
comment on table core.ai_tool_rate is
  'Assistant tool-call counter per lane, user and fixed window (T-101). Private: only core.ai_tool_gate() reads or writes it.';
alter table core.ai_tool_rate enable row level security;
revoke all on core.ai_tool_rate from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- gate
create function core.ai_tool_gate(p_lane text, p_view text, p_category text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_enabled boolean;
  v_categories text[];
  v_window timestamptz;
  v_calls integer;
begin
  if p_lane is null or p_lane !~ '^[A-Z]{1,8}$' then
    raise exception 'invalid lane' using errcode = '22023';
  end if;
  if p_view is null or not (p_view = any (core.view_names())) then
    raise exception 'invalid view' using errcode = '22023';
  end if;
  if p_category is null or not (p_category = any (array['email', 'calendar', 'docs', 'finance', 'finance_summary', 'tasks']::text[])) then
    raise exception 'invalid category' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 or p_window_seconds is null or p_window_seconds not between 1 and 3600 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;

  if v_uid is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_required', 'role', null);
  end if;

  select m.role, l.enabled into v_role, v_enabled
  from core.memberships m
  join core.lanes l on l.code = m.lane_id
  where m.user_id = v_uid and m.lane_id = p_lane;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'not_member', 'role', null);
  end if;
  -- admin_technical has no access to any content (spec §3), whatever views exist.
  if v_role = 'admin_technical' then
    return jsonb_build_object('allowed', false, 'reason', 'role_denied', 'role', v_role);
  end if;
  if not v_enabled then
    return jsonb_build_object('allowed', false, 'reason', 'lane_disabled', 'role', v_role);
  end if;

  select lp.llm_allowed_categories into v_categories from core.lane_policies lp where lp.lane_id = p_lane;
  if not (p_category = any (coalesce(v_categories, '{}'::text[]))) then
    return jsonb_build_object('allowed', false, 'reason', 'category_denied', 'role', v_role);
  end if;

  if not (p_lane = any (core.allowed_lanes(v_uid, 'assistant'))) or not (p_lane = any (core.allowed_lanes(v_uid, p_view))) then
    return jsonb_build_object('allowed', false, 'reason', 'view_denied', 'role', v_role);
  end if;

  -- Fixed window; the counter only increments while under the limit, so a denied call does not extend the block.
  v_window := pg_catalog.to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  delete from core.ai_tool_rate r where r.lane_id = p_lane and r.user_id = v_uid and r.window_start < v_window;
  insert into core.ai_tool_rate as r (lane_id, user_id, window_start, calls)
  values (p_lane, v_uid, v_window, 1)
  on conflict (lane_id, user_id, window_start) do update set calls = r.calls + 1 where r.calls < p_limit
  returning r.calls into v_calls;
  if v_calls is null then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'role', v_role);
  end if;

  return jsonb_build_object('allowed', true, 'reason', null, 'role', v_role);
end;
$$;
comment on function core.ai_tool_gate(text, text, text, integer, integer) is
  'Assistant policy gate (T-101): aal2, membership/role, lane enabled, llm_allowed_categories, assistant + required view, rate limit, for auth.uid() only. Returns {allowed, reason, role}; no data.';
revoke all on function core.ai_tool_gate(text, text, text, integer, integer) from public, anon, service_role;
grant execute on function core.ai_tool_gate(text, text, text, integer, integer) to authenticated;
