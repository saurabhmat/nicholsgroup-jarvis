-- T-042: retention purge entry points for the retention.purge job (service_role only; the job never deletes directly).
--   core.retention_comms_purge(lane, keep)  -> comms.message_index_purge (T-061). comms/cal are not exposed to PostgREST, so
--   core.retention_cal_purge(lane, keep)    -> cal.event_index_purge     (T-061)   the job reaches them through these.
-- Both are SECURITY INVOKER: they run with the caller's (service_role) privileges and add nothing; the T-061 functions
-- keep enforcing the floors and caps (comms: at most the lane policy's retention_days, at least 1 day; calendar: 30 to 180
-- days). Here we only require an enabled lane and an explicit interval, so the job cannot lean on a default.
--   core.source_records_purge_bodies(lane)  -> deletes raw.source_records rows of content providers whose payload carries a
-- body field, for a lane whose policy has store_content_bodies off or missing (T-039 note: bodies stored while the policy
-- was on must not outlive the policy). SECURITY DEFINER (raw has no grants); lane-checked; returns the number of rows.
-- (fin.* rows that point at a deleted raw row get raw_record_id set to null by their foreign key; content providers do not feed
-- fin today.) A lane with the policy on deletes nothing. No table is added, so there is no new RLS surface; cross-lane denial is tested in 190.

create function core.retention_comms_purge(p_lane text, p_keep interval)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_lane is null or p_keep is null then
    raise exception 'lane and keep interval are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '42501';
  end if;
  return comms.message_index_purge(p_lane, p_keep);
end;
$$;
comment on function core.retention_comms_purge(text, interval) is
  'Retention job entry (T-042): calls comms.message_index_purge for an enabled lane with an explicit interval. Invoker; service_role only.';
revoke all on function core.retention_comms_purge(text, interval) from public, anon, authenticated;
grant execute on function core.retention_comms_purge(text, interval) to service_role;

create function core.retention_cal_purge(p_lane text, p_keep interval)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_lane is null or p_keep is null then
    raise exception 'lane and keep interval are required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '42501';
  end if;
  return cal.event_index_purge(p_lane, p_keep);
end;
$$;
comment on function core.retention_cal_purge(text, interval) is
  'Retention job entry (T-042): calls cal.event_index_purge for an enabled lane with an explicit interval. Invoker; service_role only.';
revoke all on function core.retention_cal_purge(text, interval) from public, anon, authenticated;
grant execute on function core.retention_cal_purge(text, interval) to service_role;

create function core.source_records_purge_bodies(p_lane text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '42501';
  end if;
  -- Policy on: nothing to purge. Off or no policy row: bodies must go.
  if coalesce((select p.store_content_bodies from core.lane_policies p where p.lane_id = p_lane), false) then
    return 0;
  end if;
  delete from raw.source_records r
  where r.lane_id = p_lane
    and raw.is_content_provider(r.provider)
    and raw.payload_has_body_field(r.payload);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.source_records_purge_bodies(text) is
  'Retention job entry (T-042, T-039 note): deletes a lane''s content-provider raw records that carry body fields when the lane policy store_content_bodies is off. Lane-checked; service_role only.';
revoke all on function core.source_records_purge_bodies(text) from public, anon, authenticated;
grant execute on function core.source_records_purge_bodies(text) to service_role;
