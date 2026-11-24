-- T-170 (security suite), rules 6 and 7 as security properties.
-- Rule 6: no message or chat BODY is stored unless the lane policy allows it. Catalog: every column that could hold a body (found by name and type across
--   every app schema) is classified with the policy that governs it; a new candidate fails until classified; no mail, calendar or Teams table has a
--   body-shaped column at all; outbound drafts are stored only when `store_outbound_drafts` is on (refused otherwise) and are purged at a terminal state.
-- Rule 7: AI output never writes financial tables. Catalog: the functions that write any `fin` table are found from their source; none is executable by
--   authenticated, none is called by any code that handles model output, and a signed-in owner cannot write a fin table directly or through them.
begin;
select plan(13);
\ir helpers/lane_rls.psql

-- ------------------------------------------------------------------ rule 6: catalog of body-capable columns
create temp table body_policy (col text primary key, policy text not null) on commit drop;
insert into body_policy values
  ('brain.documents.body_md', 'owner-authored brain notes (not mail or chat); brain view only; secret scan on write'),
  ('brain.document_versions.body_md', 'versions of the same notes'),
  ('brain.skills.body_md', 'owner-authored skills text'),
  ('brain.employees.instructions_md', 'owner-authored instructions'),
  ('brief.briefings.content', 'AI briefing built from metadata only (no bodies); purged by the retention job (30 days at most)'),
  ('act.proposed_actions.payload', 'the composed outbound text (email bodyText, Teams text): stored only if lane policy store_outbound_drafts, hashed, purged at every terminal state (payload_purged_at)'),
  ('raw.source_records.payload', 'provider records, service role only, body fields purged by the retention job (policy class)'),
  ('fin.report_cache.payload', 'QuickBooks report figures (no free text with digits runs: fin.report_cache_guard)'),
  ('comms.message_index.summary', 'an AI summary stored only after the owner approved it (summary_approved_* check); never the body'),
  ('core.connector_api_errors.provider_message', 'a fixed or scrubbed provider message (error-log/scrub.ts)');
create temp table body_cols on commit drop as
select n.nspname || '.' || c.relname || '.' || a.attname as col
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  and a.atttypid in ('text'::regtype, 'jsonb'::regtype, 'json'::regtype)
  and a.attname ~* '(^|_)(body|bodies|content|html|snippet|preview|payload|md|text|instructions|summary|message|transcript|raw)($|_)'
  and a.attname not in ('message_id', 'provider_message_id') and a.attname !~ '(hash|sha256|allowed)';
select is((select coalesce(array_agg(col order by col), '{}') from body_cols where col not in (select col from body_policy)), '{}'::text[],
  'every column that could hold a body (text, json or jsonb named body, content, html, snippet, payload, md, text, summary, message, raw ...) is classified with its governing policy');
select is((select coalesce(array_agg(col order by col), '{}') from body_policy where col not in (select col from body_cols)), '{}'::text[], 'no stale entry in the body-column classification');
select is((select coalesce(array_agg(n.nspname || '.' || c.relname || '.' || a.attname order by 1), '{}') from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('comms','cal') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attname ~* '(body|html|snippet|preview|raw|content|transcript|full_text)'), '{}'::text[],
  'the mail, chat and calendar tables have no body-shaped column at all (subject, sender, times and flags only)');

-- Wider net for the mail, chat and calendar tables: EVERY text, json, jsonb and text[] column there is classified (whatever its name), so a new column such as `notes`
-- cannot appear unnoticed. (337 also covers free-text columns anywhere by name.)
create temp table mail_cols_ok (col text primary key, why text not null) on commit drop;
insert into mail_cols_ok
select c, 'message or event metadata: ids, addresses, names, subject, folder, labels, flags or times as text; no body' from unnest(array[
  'cal.event_index.attendees','cal.event_index.calendar_id','cal.event_index.event_id','cal.event_index.ical_uid','cal.event_index.lane_id','cal.event_index.location',
  'cal.event_index.online_meeting_url','cal.event_index.organizer_email','cal.event_index.organizer_name','cal.event_index.provider','cal.event_index.recurring_event_id',
  'cal.event_index.source_url','cal.event_index.status','cal.event_index.timezone','cal.event_index.title',
  'comms.message_index.category','comms.message_index.cc_recipients','comms.message_index.classifier_model','comms.message_index.classifier_version','comms.message_index.folder',
  'comms.message_index.from_address','comms.message_index.from_name','comms.message_index.labels','comms.message_index.lane_id','comms.message_index.message_id',
  'comms.message_index.provider','comms.message_index.source_url','comms.message_index.subject','comms.message_index.summary','comms.message_index.thread_id','comms.message_index.to_recipients',
  'comms.teams_activity.lane_id','comms.teams_chat_reads.chat_id','comms.teams_chat_reads.lane_id']) c;
select is((select coalesce(array_agg(n.nspname || '.' || c.relname || '.' || a.attname order by 1), '{}') from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('comms','cal') and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.atttypid in ('text'::regtype, 'jsonb'::regtype, 'json'::regtype, 'text[]'::regtype)
             and n.nspname || '.' || c.relname || '.' || a.attname not in (select col from mail_cols_ok)), '{}'::text[],
  'every text, json, jsonb or array column of the mail, chat and calendar tables is classified as metadata (a new column, whatever its name, fails until reviewed)');
select is((select coalesce(array_agg(col order by col), '{}') from mail_cols_ok where col not in (select n.nspname || '.' || c.relname || '.' || a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('comms','cal') and a.attnum > 0 and not a.attisdropped)), '{}'::text[],
  'no stale entry in the mail, chat and calendar column list');

-- ------------------------------------------------------------------ rule 6: outbound drafts only when the lane policy allows, and purged
update core.lane_policies set write_actions_allowed = array['email_send', 'email_draft', 'teams_send'] where lane_id = 'PKG';
insert into core.connections (id, lane_id, provider, external_account_id, status, features, owner_user_id)
values ('00000000-0000-4000-8000-000000033900', 'PKG', 'google', 'rule6-owner@g.example.test', 'active', '{"gmail_compose": true}', pg_temp.uid('owner@example.test'));
create function pg_temp.try_propose(p_h text) returns text language plpgsql as $$
begin
  perform core.act_propose('PKG', 'email.send', '00000000-0000-4000-8000-000000033900', '{"mailbox":"rule6-owner@g.example.test"}'::jsonb,
    '{"fromMailbox":"rule6-owner@g.example.test","bodyText":"RULE6-BODY-CANARY"}'::jsonb, 1, p_h, null, '[]'::jsonb, 'user', pg_temp.uid('owner@example.test'), false);
  return 'accepted';
exception when others then return sqlstate || ' ' || sqlerrm;
end $$;
update core.lane_policies set store_outbound_drafts = false where lane_id = 'PKG';
set local role service_role;
select is(pg_temp.try_propose(repeat('1', 64)), '42501 act: this lane does not allow storing outbound drafts', 'rule 6: with store_outbound_drafts off, an outbound email body cannot be stored (refused at propose)');
reset role;
update core.lane_policies set store_outbound_drafts = true where lane_id = 'PKG';
set local role service_role;
select is(pg_temp.try_propose(repeat('2', 64)), 'accepted', 'rule 6 control: with the flag on the same proposal is accepted');
reset role;
select is((select count(*)::int from act.proposed_actions where payload::text like '%RULE6-BODY-CANARY%' and payload_purged_at is null), 1, 'the body is held while the proposal is pending');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select core.act_reject('PKG', (select id from act.proposed_actions where payload::text like '%RULE6-BODY-CANARY%'), 'rule 6 purge check');
reset role;
select is((select count(*)::int from act.proposed_actions where payload::text like '%RULE6-BODY-CANARY%'), 0, 'rule 6: once the proposal is rejected (a terminal state) the body is purged from the row');
select is((select count(*)::int from act.status_history where reason::text like '%RULE6-BODY-CANARY%') + (select count(*)::int from audit.events where metadata::text like '%RULE6-BODY-CANARY%'), 0, 'the body never reaches the status history or the audit trail');

create function pg_temp.denied_write() returns boolean language plpgsql as $$
declare ok int := 0;
begin
  begin insert into fin.transactions (lane_id) values ('PKG'); exception when insufficient_privilege then ok := ok + 1; when others then null; end;
  begin update fin.invoices set lane_id = lane_id; exception when insufficient_privilege then ok := ok + 1; when others then null; end;
  begin delete from fin.bills where true; exception when insufficient_privilege then ok := ok + 1; when others then null; end;
  begin perform core.fin_report_cache_put('PKG', null, null, null, null, null, null, null); exception when insufficient_privilege then ok := ok + 1; when undefined_function then ok := ok + 1; when others then null; end;
  begin perform core.fin_qbo_normalize('PKG', null); exception when insufficient_privilege then ok := ok + 1; when undefined_function then ok := ok + 1; when others then null; end;
  return ok = 5;
end $$;

-- ------------------------------------------------------------------ rule 7: nothing model-reachable writes fin
select is((select coalesce(array_agg(n.nspname || '.' || p.proname order by 1), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and p.prokind = 'f'
             and p.prosrc ~* '(insert into|update|delete from|truncate)\s+(fin\.)'
             and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), '{}'::text[],
  'rule 7: no function that writes a fin table can be executed by authenticated or anon (the model works with the signed-in user''s role)');
select is((select string_agg(p.proname::text, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('act','audit','brain','brief','cal','comms','core','fin','raw') and p.prokind = 'f' and p.prosrc ~* '(insert into|update|delete from|truncate)\s+fin\.'),
          'fin_qbo_normalize,fin_report_cache_put', 'rule 7: the only fin writers are the QuickBooks normalizer and the report cache writer (service role, called by connector jobs); a new writer fails here');
select pg_temp.claims('owner@example.test', 'aal2');
set local role authenticated;
select is((select (select count(*) from (select 1) x where (select pg_temp.denied_write()))::int), 1, 'rule 7: a signed-in owner at AAL2 cannot insert into, update or call the writers of fin tables (insufficient_privilege)');
reset role;
select * from finish();
rollback;
