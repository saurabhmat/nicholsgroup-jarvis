-- T-234 part 0: why the newest briefing attempt failed (Home shows a fixed reason, never a raw message).
-- core.briefing_last_failure(p_lane): for the CALLER (auth.uid()) in the lane, the newest attempt; when that attempt failed,
-- one row (prepared_at, reason) where reason is the code stored as the note "fail:<code>" (codes only; null when the
-- attempt predates codes). No row when the newest attempt did not fail or there is none. Invoker: RLS on brief.briefings
-- applies (AAL2, own rows, briefing view). No table is created or changed.
create function core.briefing_last_failure(p_lane text)
returns table (prepared_at timestamptz, reason text)
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
  select newest.prepared_at,
         (select pg_catalog.substr(n.note, 6)
            from pg_catalog.jsonb_array_elements_text(
                   case when pg_catalog.jsonb_typeof(newest.content -> 'notes') = 'array' then newest.content -> 'notes' else '[]'::jsonb end) as n(note)
           where n.note ~ '^fail:[a-z_]{1,40}$'
           limit 1)
  from (select a.prepared_at, a.status, a.content
          from brief.briefings a
         where a.lane_id = p_lane and a.owner_user_id = auth.uid()
         order by a.prepared_at desc
         limit 1) newest
  where newest.status = 'failed';
end;
$$;
comment on function core.briefing_last_failure(text) is
  'T-234: the caller''s newest briefing attempt in a lane when it failed, with its stored failure code (fail:<code> note). Invoker: RLS applies.';
revoke all on function core.briefing_last_failure(text) from public, anon;
grant execute on function core.briefing_last_failure(text) to authenticated, service_role;
