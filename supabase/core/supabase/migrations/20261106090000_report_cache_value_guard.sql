-- T-052 (QuickBooks Reports API; T-055 final security review M4): value checks in fin.report_cache_guard, and the
-- jobs' write function. (No role-wide statement_timeout: see plan-review, T-052.)
--
-- 1. fin.report_cache_guard (replaced in place; same name, trigger and grants):
--    * a payload that is not a JSON object raises here (23514). The old guard let it through to the table check, whose
--      error message echoes the failing row (the whole payload, i.e. table data) in DETAIL.
--    * any string value (at any depth) that contains a letter AND a run of 5 or more digits is refused (22023). Report
--      labels are free text ("Operating Checking 123456789"); the connector masks such runs first, this is the backstop.
--      A value with digits only (amounts, ids, dates) is fine; a date-time such as 2026-11-06T10:00:00-08:00 has no run
--      of 5. "Letter" is any ASCII letter or any non-ASCII character (conservative: no locale dependence). Digits are
--      compared after NFKC normalisation, so full-width digits count; other scripts' digits are masked by the connector.
--    * every message is constant and no DETAIL, HINT or CONTEXT carries data, so a refused value never reaches the
--      Postgres log or a job log.
-- 2. core.fin_report_cache_put: the jobs' write path. PostgREST exposes core, not fin (like the comms/cal apply functions),
--    so the report writer calls this security-invoker wrapper as service_role. Lane-checked against a usable QuickBooks
--    connection; idempotent on (connection, report, params, as_of): a second put of the same key replaces payload and
--    fetched_at. The guard trigger above runs on it. Constant messages.
create or replace function fin.report_cache_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(new.payload) is distinct from 'object' then
    raise exception 'fin.report_cache: payload must be a JSON object' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.payload is not distinct from old.payload then
    return new;
  end if;
  if exists (select 1 from pg_catalog.jsonb_object_keys(new.payload) k where k <> all (array['Header', 'Columns', 'Rows'])) then
    raise exception 'fin.report_cache: payload has a top-level key that is not allowed' using errcode = '23514';
  end if;
  if (raw.payload_scan(new.payload, 'quickbooks', false)).has_forbidden then
    raise exception 'fin.report_cache: payload contains a field that must not be stored' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_path_query(new.payload, 'strict $.**') v
    where pg_catalog.jsonb_typeof(v) = 'string'
      and normalize(v #>> '{}', NFKC) ~ '[[:alpha:]]|[^\x01-\x7f]'
      and normalize(v #>> '{}', NFKC) ~ '[0-9]{5}'
  ) then
    raise exception 'fin.report_cache: payload contains a text value that looks like an account number' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function fin.report_cache_guard() from public, anon, authenticated;

-- An unchanged payload is not re-scanned, so a row stored before this guard existed would keep a value it now refuses.
-- Nothing has written to the cache yet (the writer arrives with this migration), and cache rows are disposable (a later
-- pull rebuilds them): remove any that fail the value rule instead of leaving them behind.
delete from fin.report_cache c
where exists (
  select 1
  from pg_catalog.jsonb_path_query(c.payload, 'strict $.**') v
  where pg_catalog.jsonb_typeof(v) = 'string'
    and normalize(v #>> '{}', NFKC) ~ '[[:alpha:]]|[^\x01-\x7f]'
    and normalize(v #>> '{}', NFKC) ~ '[0-9]{5}'
);


create function core.fin_report_cache_put(
  p_lane text, p_connection_id uuid, p_report text, p_params jsonb, p_payload jsonb, p_as_of timestamptz, p_fetched_at timestamptz
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lane is null or p_connection_id is null or p_report is null or p_params is null or p_payload is null or p_as_of is null or p_fetched_at is null then
    raise exception 'fin.report_cache_put: every argument is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.connections c
                 join core.lanes l on l.code = c.lane_id and l.enabled
                 where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded')) then
    raise exception 'fin.report_cache_put: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  insert into fin.report_cache (lane_id, connection_id, report, params, payload, as_of, fetched_at)
  values (p_lane, p_connection_id, p_report, p_params, p_payload, p_as_of, p_fetched_at)
  on conflict (lane_id, connection_id, report, params_hash, as_of) do update
    set payload = excluded.payload, fetched_at = excluded.fetched_at
  returning id into v_id;
  return v_id;
end;
$$;
comment on function core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz) is
  'Writes one QuickBooks report to fin.report_cache for a usable QuickBooks connection of the lane; idempotent per (connection, report, params, as_of). Service_role only (T-052).';
revoke all on function core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function core.fin_report_cache_put(text, uuid, text, jsonb, jsonb, timestamptz, timestamptz) to service_role;
