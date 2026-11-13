-- T-238: why did PKG mail stop about 6 days ago? READ-ONLY queries for the production SQL Editor (select only; no writes).
-- No mail content: counts, times, statuses and error kinds only. Paste the result grids back to the agent.
-- Valid with production parts 1-14 applied (does not use sync_runs.job from part 16).

-- 1. Connections: status, transport, features, last sync and last error kind.
select c.id, c.provider, c.transport, c.status, c.features, c.last_sync_at, c.last_error->>'kind' as last_error_kind,
       c.last_error->>'disposition' as disposition, c.token_expires_at, c.created_at, c.updated_at
from core.connections c where c.lane_id = 'PKG' order by c.created_at;

-- 2. Newest stored mail and calendar data (what Home can show at most).
select 'mail' as stream, max(received_at) as newest_item, max(created_at) as newest_insert, max(updated_at) as newest_update, count(*) as rows
from comms.message_index where lane_id = 'PKG' and not deleted
union all
select 'calendar', max(start_at), max(created_at), max(updated_at), count(*) from cal.event_index where lane_id = 'PKG';

-- 3. Mail vs calendar rows written per New York day (inserted or updated), last 14 days.
select d, stream, count(*) from (
  select (updated_at at time zone 'America/New_York')::date as d, 'mail' as stream from comms.message_index where lane_id = 'PKG'
  union all
  select (updated_at at time zone 'America/New_York')::date, 'calendar' from cal.event_index where lane_id = 'PKG'
) x where d >= (now() at time zone 'America/New_York')::date - 14
group by 1, 2 order by 1 desc, 2;

-- 4. Sync cursors: which kind of position each stream holds (f = first load page, i = history page, h = caught up) and when it last moved.
select s.connection_id, s.stream, substring(s.cursor_value from '(?:^|[.:])([fih]):') as cursor_kind, s.updated_at
from core.sync_cursors s where s.lane_id = 'PKG' order by s.connection_id, s.stream;

-- 5. Sync runs per New York day: trigger, outcome, error kind, rows written, last 14 days.
select (r.started_at at time zone 'America/New_York')::date as d, r.trigger, r.kind, r.status, r.error->>'kind' as error_kind,
       count(*) as runs, sum(r.records_written) as written, max(r.started_at) as last_start
from core.sync_runs r where r.lane_id = 'PKG' and r.started_at >= now() - interval '14 days'
group by 1, 2, 3, 4, 5 order by 1 desc, 2, 4;

-- 6. Runs left open (a crashed worker; cancelled by the next start after 30 min).
select id, connection_id, trigger, started_at from core.sync_runs where lane_id = 'PKG' and status = 'running';
