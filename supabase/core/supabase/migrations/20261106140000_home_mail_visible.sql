-- Home mail counts (T-201 security review M1): core.home_mail_attention returned one row of zeros to a caller without
-- the comms view (an aggregate always returns a row), so Home told admin_technical "no unread important email" about
-- mail it may not see. Same signature; it now returns no row unless the caller holds the comms view on the lane at
-- AAL2 (service_role unchanged). RLS on comms.message_index still applies to the counts themselves. Tests: 230.

create or replace function core.home_mail_attention(p_lane text, p_since timestamptz)
returns table (unread_important integer, unread_priority integer, priority_configured boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_senders text[];
begin
  if p_lane is null or p_since is null then
    raise exception 'lane and since are required' using errcode = '22004';
  end if;
  if p_since < now() - interval '7 days' then
    raise exception 'since must be within the last 7 days' using errcode = '22023';
  end if;
  -- No row (not zero counts) for a caller who may not read this lane's mail: Home then says nothing about mail.
  if current_user <> 'service_role'
     and (coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(auth.uid(), 'comms')))) then
    return;
  end if;
  select coalesce(array_agg(lower(s.value)), '{}')
    into v_senders
  from core.lane_config_current c,
       jsonb_array_elements_text(case when jsonb_typeof(c.config -> 'priority_senders') = 'array' then c.config -> 'priority_senders' else '[]'::jsonb end) s(value)
  where c.lane_id = p_lane;

  return query
  select
    count(*) filter (where m.is_important)::integer,
    count(*) filter (where cardinality(v_senders) > 0 and (
      lower(m.from_address) = any (v_senders)
      or ('@' || split_part(lower(m.from_address), '@', 2)) = any (v_senders)
    ))::integer,
    cardinality(v_senders) > 0
  from comms.message_index m
  where m.lane_id = p_lane
    and not m.deleted
    and not m.is_read
    and m.folder = 'INBOX'
    and m.received_at >= p_since;
end;
$$;
