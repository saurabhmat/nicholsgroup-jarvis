-- T-170 (security suite), area 3 (database side): where a token or secret could be STORED. Catalog-driven over every jsonb column in an
-- app schema: it is either guarded by a CHECK that calls core.jsonb_has_secret, or on a reviewed list with the reason why no secret can reach
-- it. Secret-named columns must be vault references only. The guard function is probed with token shapes (key names, camelCase, nested, vendor
-- prefixes, JWTs); the guarded columns are shown to refuse a planted fake token.
begin;
select plan(8);
\ir helpers/lane_rls.psql

create function pg_temp.refused_23514(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when check_violation then return true;
          when others then return sqlstate = '23514';
end $$;

create temp table reviewed_unguarded (col text primary key, why text not null) on commit drop;
insert into reviewed_unguarded values
  ('core.connections.features', 'booleans and scope names written by the connect callback, checked by core.is_connection_features'),
  ('raw.source_records.payload', 'provider records (not credentials), purged by retention; written only by connector sinks'),
  ('fin.report_cache.params', 'report parameters; guarded by fin.report_cache_guard (key and depth rules)'),
  ('fin.report_cache.payload', 'QuickBooks report figures; guarded by fin.report_cache_guard (no string with letters and 5+ digits)'),
  ('comms.message_index.cc_recipients', 'addresses only, checked by comms.recipients_ok'),
  ('comms.message_index.to_recipients', 'addresses only, checked by comms.recipients_ok'),
  ('cal.event_index.attendees', 'attendee addresses and names only, checked by cal.attendees_ok'),
  ('fin.normalize_runs.counts', 'counters'),
  ('fin.normalize_runs.reallocations', 'amounts and account ids'),
  ('brief.briefings.content', 'AI briefing output built from metadata (no bodies); governed by lane policy retention (rule 6 catalog, test 339)'),
  ('brief.briefings.coverage', 'counters and source states'),
  ('brief.briefings.source_refs', 'ids and labels'),
  ('act.proposed_actions.payload', 'the exact approved content (hashed); typed per action type and purged after use (rule 6 catalog, test 339)'),
  ('act.proposed_actions.source_refs', 'ids of the sources the proposal was derived from'),
  ('act.proposed_actions.payload_sha256', 'a hash'),
  ('act.proposed_actions.rationale', 'one sentence written by the proposer (max 2000 characters), no content'),
  ('act.status_history.reason', 'fixed reason strings written by the approval functions'),
  ('brain.skills.title', 'a title chosen by the owner'),
  ('brief.news_digests.items', 'news headlines and urls'),
  ('cal.event_index.location', 'event metadata (external text, untrusted data)'),
  ('cal.event_index.title', 'event metadata (external text, untrusted data)'),
  ('comms.message_index.message_id', 'a provider message id'),
  ('comms.message_index.subject', 'message metadata (external text, untrusted data); no bodies are stored'),
  ('comms.message_index.summary', 'an approved summary (summary_approved_* columns)'),
  ('core.connections.last_error_stream', 'enum mail or calendar'),
  ('core.connector_api_errors.provider_error_code', 'a short code, checked by the table'),
  ('core.connector_api_errors.provider_message', 'a fixed or scrubbed message (error-log/scrub.ts; canary-sinks.test.ts proves it)'),
  ('core.job_failures.last_error_code', 'a short code'),
  ('core.lane_policies.cross_lane_summary_allowed', 'enum'),
  ('core.webhook_events.payload_hash', 'a hash'),
  ('fin.report_cache.params_hash', 'a hash'),
  ('raw.source_records.payload_hash', 'a hash');

-- Candidates: every json/jsonb column, and every text column whose name says it holds free text. Guard = a CHECK that calls the secret detectors or the connector-error shape.
create temp table jcols on commit drop as
select n.nspname || '.' || c.relname || '.' || a.attname as col,
       exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'c'
               and pg_get_constraintdef(k.oid) ~ '(has_secret|looks_like|is_connector_error)' and pg_get_constraintdef(k.oid) like '%' || a.attname || '%') as guarded
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and c.relkind = 'r'
  and a.attnum > 0 and not a.attisdropped
  and (a.atttypid in ('jsonb'::regtype, 'json'::regtype)
       or (a.atttypid = 'text'::regtype and a.attname ~* '(error|message|note|reason|detail|payload|body|content|summary|config|metadata|features|params|items|text|md|label|title|subject|location|rationale|instruction|description|snippet)'));

select is((select coalesce(array_agg(col order by col), '{}') from jcols where not guarded and col not in (select col from reviewed_unguarded)), '{}'::text[],
  'every json/jsonb column and every free-text column (by name) is guarded against secrets or on the reviewed list (a new one needs a decision)');
select is((select coalesce(array_agg(col order by col), '{}') from reviewed_unguarded where col not in (select col from jcols) or col in (select col from jcols where guarded)), '{}'::text[],
  'no stale or now-guarded entry on the reviewed list');
select cmp_ok((select count(*) from jcols where guarded), '>=', 9::bigint, 'at least audit metadata, lane config, brain documents and employee config, and the action target and result are guarded');

select is((select coalesce(array_agg(table_schema || '.' || table_name || '.' || column_name order by 1), '{}') from information_schema.columns
           where table_schema in ('act','audit','brain','brief','cal','comms','core','fin','raw')
             and column_name ~* '(token|secret|password|passwd|credential|api_?key|bearer|refresh|vault|signing|private)'
             and column_name not in ('token_expires_at', 'vault_secret_id')), '{}'::text[],
  'no table has a column named like a token, secret, password, credential or key, other than the expiry time and Vault references');
select is((select coalesce(array_agg(table_schema || '.' || table_name || '.' || column_name order by 1), '{}') from information_schema.columns
           where table_schema in ('act','audit','brain','brief','cal','comms','core','fin','raw') and column_name = 'vault_secret_id' and data_type <> 'uuid'), '{}'::text[], 'a vault reference is a uuid, never a value');

-- The guard itself, against shapes a leak would take.
select is((select coalesce(array_agg(t order by t), '{}') from (values
    ('{"access_token":"x"}'), ('{"accessToken":"x"}'), ('{"a":{"b":[{"refresh_token":"x"}]}}'), ('{"apiKey":"x"}'), ('{"client_secret":"x"}'), ('{"password":"x"}'),
    ('{"Authorization":"Bearer x"}'), ('{"note":"sb_secret_abcdefghijklmnop"}'), ('{"note":"sk-ant-api03-abcdefghijkl"}'), ('{"note":"eyJhbGciOi.eyJzdWIiOi.sig"}'),
    ('{"note":" ghp_abcdefghijklmnopqrstuvwx"}')) v(t) where not core.jsonb_has_secret(t::jsonb)), '{}'::text[],
  'core.jsonb_has_secret flags key names (snake, camel, nested, in arrays) and vendor-prefixed or JWT strings, even with leading spaces');
select is((select coalesce(array_agg(t order by t), '{}') from (values
    ('{"max_tokens":100}'), ('{"input_tokens":1,"output_tokens":2}'), ('{"subject":"Quarterly review","count":3}'), ('{"to":["person@example.test"]}')) v(t)
  where core.jsonb_has_secret(t::jsonb)), '{}'::text[], 'ordinary content and token COUNTERS are not flagged');

-- A planted fake token is refused by the guarded columns (the real write paths, with the table's own checks).
select is((select coalesce(array_agg(w order by w), '{}') from (values
    ('audit.events.metadata', $$insert into audit.events (lane_id, actor_kind, action, metadata) values ('PKG', 'system', 'x.y', '{"access_token":"CANARY-TOKEN-1"}')$$),
    ('core.lane_config.config', $$insert into core.lane_config (lane_id, version, config) values ('APK', 2, '{"stripe":{"api_key":"CANARY-TOKEN-2"}}')$$)
  ) v(w, q) where not (select pg_temp.refused_23514(v.q))), '{}'::text[], 'CANARY: a fake token in audit metadata or in lane config is refused by the column check');

select * from finish();
rollback;
