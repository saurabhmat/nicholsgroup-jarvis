-- T-196: the connector error log (core.connector_api_errors) and run logging for every QuickBooks job (QB-9, QB-15).
--
-- 1. core.sync_runs gets a `job` column (sync | reports | normalize). conn.sync (initial load, CDC, the webhook-triggered CDC,
--    which is conn.sync with trigger 'webhook') already writes a run per connection; the report pull and the normalizer now
--    write one too. Their kind is 'snapshot' (no cursor). The one-running-run rule becomes per (connection, job), so a
--    normalizer run never blocks a sync. Counts and a redacted error only; no content.
-- 2. core.connector_api_errors: one row per provider API error (after the T-195 error map), lane scoped. Read by the 'health'
--    view (owner, admin_technical at AAL2, like sync_runs); written by the service role only; rows are never updated.
--    The connector redacts first (endpoint is a path template, the message is the error map's fixed text); the CHECKs are the
--    database's second line: no '@', no Bearer pattern, no digit run of 5 or more in endpoint or message.
-- 3. core.connector_api_errors_purge(lane): fixed 90-day window for the retention job (class "policy": no lane setting).
-- Safe to re-run: drop-if-exists, create or replace and "if not exists" only.

-- ---------------------------------------------------------------- sync_runs: job
alter table core.sync_runs add column if not exists job text not null default 'sync';
alter table core.sync_runs drop constraint if exists sync_runs_job_check;
alter table core.sync_runs add constraint sync_runs_job_check check (job in ('sync', 'reports', 'normalize'));
alter table core.sync_runs drop constraint if exists sync_runs_kind_check;
alter table core.sync_runs add constraint sync_runs_kind_check check (kind in ('full', 'incremental', 'snapshot'));
-- A sync has a cursor (full or incremental); the other jobs do not (snapshot).
alter table core.sync_runs drop constraint if exists sync_runs_job_kind_check;
alter table core.sync_runs add constraint sync_runs_job_kind_check check ((job = 'sync') = (kind <> 'snapshot'));
drop index if exists core.sync_runs_one_running_idx;
create unique index if not exists sync_runs_one_running_job_idx on core.sync_runs (connection_id, job) where status = 'running';
grant select (job) on core.sync_runs to authenticated;
comment on column core.sync_runs.job is 'Which job wrote the run: sync (conn.sync, any trigger), reports (fin.qbo_reports) or normalize (fin.qbo_normalize). T-196.';

-- ---------------------------------------------------------------- core.connector_api_errors
create table if not exists core.connector_api_errors (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  at timestamptz not null default now(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- A path template: `/v3/company/{realm}/query`. No query string, no ids, no entity names, no digit runs.
  endpoint text check (endpoint is null or (endpoint ~ '^/[A-Za-z0-9_{}./-]{0,254}$' and endpoint !~ '[0-9]{5,}')),
  http_status integer check (http_status is null or http_status between 100 and 599),
  -- The provider's error code (Intuit Fault code, up to 6 digits, or a word code). Never a message.
  provider_error_code text check (provider_error_code is null or provider_error_code ~ '^([0-9]{1,6}|[A-Za-z][A-Za-z0-9_.-]{0,63})$'),
  -- Fixed text from the connector's error map, never the provider's own message (which can echo names or amounts).
  provider_message text not null check (
    char_length(provider_message) between 1 and 300
    and provider_message !~ '@'
    and provider_message !~* 'bearer'
    and provider_message !~ '[0-9]{5,}'),
  -- The provider's request id (Intuit `intuit_tid`).
  provider_tid text check (provider_tid is null or provider_tid ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  kind text not null check (kind in ('lane_mismatch', 'connection_unavailable', 'reconnect_required', 'unsupported_op',
                                     'invalid_input', 'rate_limited', 'transient', 'timeout', 'not_found', 'forbidden', 'provider_error')),
  disposition text not null check (disposition in ('retry', 'reconnect_required', 'fail')),
  retry_after_seconds integer check (retry_after_seconds is null or retry_after_seconds between 0 and 86400),
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict
);
comment on table core.connector_api_errors is 'One row per provider API error after the connector error map (T-196, QB-9/QB-15). Redacted fields only; written by the service role, kept 90 days, exported for provider support.';
create index if not exists connector_api_errors_lane_at_idx on core.connector_api_errors (lane_id, at desc);
create index if not exists connector_api_errors_connection_at_idx on core.connector_api_errors (connection_id, at desc);

alter table core.connector_api_errors enable row level security;
drop policy if exists connector_api_errors_select on core.connector_api_errors;
create policy connector_api_errors_select on core.connector_api_errors
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );

revoke all on core.connector_api_errors from public, anon, authenticated, service_role;
grant select (id, lane_id, connection_id, at, provider, endpoint, http_status, provider_error_code, provider_message, provider_tid,
              kind, disposition, retry_after_seconds)
  on core.connector_api_errors to authenticated;
-- The service role records and reads; it never updates or deletes directly (the purge function deletes).
grant select, insert on core.connector_api_errors to service_role;

-- ---------------------------------------------------------------- purge (retention)
-- Fixed 90-day window, no parameter: a caller cannot widen or narrow it. One lane only, enabled lanes only.
create or replace function core.connector_api_errors_purge(p_lane text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not available' using errcode = '42501';
  end if;
  delete from core.connector_api_errors e where e.lane_id = p_lane and e.at < pg_catalog.now() - interval '90 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.connector_api_errors_purge(text) is 'Retention (T-196, called by the T-042 purge job): deletes a lane''s connector API errors older than 90 days.';
revoke all on function core.connector_api_errors_purge(text) from public, anon, authenticated;
grant execute on function core.connector_api_errors_purge(text) to service_role;
