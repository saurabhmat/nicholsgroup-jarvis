-- T-105/T-106: which assistant tool categories the CALLER may use in a lane (T-101 code review M6c). The chat route
-- offers the model only these tools, and the page shows a disabled state when the list is empty. The gate
-- (core.ai_tool_gate) still checks every call. Definer because a finance_operator may not read core.lane_policies.
-- Returns '{}' unless auth.uid() is at aal2, a member of the enabled lane with the 'assistant' view, and not
-- admin_technical. Categories only: no other policy field.
create function core.ai_tool_categories(p_lane text)
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
      and m.role <> 'admin_technical'
      and p_lane = any (core.allowed_lanes((select auth.uid()), 'assistant'))
  ), '{}'::text[]);
$$;
comment on function core.ai_tool_categories(text) is
  'Assistant tool categories the caller may use in a lane (T-105): aal2 member with the assistant view, not admin_technical; else {}.';
revoke all on function core.ai_tool_categories(text) from public, anon, service_role;
grant execute on function core.ai_tool_categories(text) to authenticated;
