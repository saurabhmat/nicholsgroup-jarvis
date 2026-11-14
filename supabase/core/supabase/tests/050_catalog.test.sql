-- RLS catalog test (T-013). Fails when any object in an app schema breaks the lane conventions. App schemas are every
-- schema except Supabase/Postgres platform ones, so a new schema is checked automatically. Exceptions are explicit,
-- reviewed lists with a reason per entry; a stale entry (object no longer exists) also fails.
-- Policies are compared as whole expressions against the canonical text, never by fragment (T-013 review H1, M1).
begin;
select plan(20);
\ir helpers/lane_rls.psql

create temp table platform_schemas (name text primary key) on commit drop;
insert into platform_schemas values
  ('_realtime'), ('auth'), ('extensions'), ('graphql'), ('graphql_public'), ('information_schema'), ('pg_catalog'),
  ('pg_toast'), ('pgbouncer'), ('realtime'), ('storage'), ('supabase_functions'), ('supabase_migrations'), ('vault'),
  ('net'), ('cron'), ('pgsodium'), ('pgsodium_masks');

-- Control-plane tables that are not lane-scoped by design (T-012 review L4).
create temp table no_lane_id_ok (name text primary key, why text not null) on commit drop;
insert into no_lane_id_ok values
  ('core.lanes', 'the lane registry itself; keyed by code'),
  ('core.users', 'one profile per person across lanes; visibility via memberships'),
  ('core.mfa_verification_attempts', 'per-user security counter written by the auth hook; no API access'),
  ('core.mfa_enrolment_state', 'per-user MFA enrolment guard (T-020); no API access');

-- Private tables: RLS on with NO policy (deny all) and no grants to API roles; reached only by definer code.
create temp table private_table_ok (name text primary key, why text not null) on commit drop;
insert into private_table_ok values
  ('core.mfa_verification_attempts', 'MFA attempt guard (T-019), written by core.mfa_verification_attempt()'),
  ('core.mfa_enrolment_state', 'MFA enrolment guard (T-020); reset allowances are granted by an admin in SQL (runbook)'),
  ('core.connection_secrets', 'connection -> Vault secret id (T-032); only the core.connection_token_* functions'),
  ('core.oauth_states', 'OAuth connect state + PKCE verifier (T-035); only core.oauth_state_create / _consume'),
  ('raw.source_records', 'raw provider payloads (T-039); only core.source_records_upsert'),
  ('core.ai_tool_rate', 'assistant tool-call rate counter (T-101); only core.ai_tool_gate'),
  ('core.ai_chat_rate', 'assistant chat-turn rate counter (T-105); only core.ai_chat_turn');

-- Tables whose SELECT policy is not the exact standard expression (reviewed by hand; each still requires aal2).
create temp table custom_policy_ok (name text primary key, why text not null) on commit drop;
insert into custom_policy_ok values
  ('brief.briefings', 'standard expression (briefing view) AND owner_user_id = auth.uid(): a prepared briefing is its owner''s alone (T-231c)'),
  ('brief.briefing_runs', 'standard expression (briefing view) AND owner_user_id = auth.uid(): a run claim is its owner''s alone; written only by definer functions (T-235)'),
  ('core.memberships', 'own rows, plus lanes with the memberships view'),
  ('core.users', 'own row, plus members of lanes with the memberships view'),
  ('core.lanes', 'standard expression on code (the lane id) instead of lane_id'),
  ('brain.documents', 'standard expression AND (kind not about_me/preferences OR owner_user_id = auth.uid()): a user''s About-Me and Preferences are theirs alone (T-210)'),
  ('brain.document_versions', 'same as brain.documents: kind and owner_user_id are copied onto each version by a trigger (T-210)'),
  ('brain.imports', 'standard expression AND user_id = auth.uid(): an import is its user''s alone (T-210)'),
  ('brain.import_candidates', 'standard expression AND user_id = auth.uid() AND created_at within 24 h: candidates are their user''s alone and expire (T-210)'),
  ('brain.section_completions', 'standard expression AND user_id = auth.uid(): completion is its user''s alone (T-227)'),
  ('act.proposed_actions', 'standard expression for the approvals view (owner) OR (proposer_user_id = auth.uid() AND lane member): a proposer sees their own proposals (T-232, approvals spec §4)');

-- Tables where authenticated may write directly (grants or write policies). Empty: writes go through service code or
-- reviewed security-definer functions.
create temp table user_dml_ok (name text primary key, why text not null) on commit drop;

-- Materialized views or foreign tables authenticated may read (they bypass RLS). Empty.
create temp table unprotected_read_ok (name text primary key, why text not null) on commit drop;

-- Security-definer functions (they bypass RLS and run as their owner). Each one is reviewed.
create temp table security_definer_ok (name text primary key, why text not null) on commit drop;
insert into security_definer_ok values
  ('brief.briefings_guard', 'insert trigger: reply drafts only with store_outbound_drafts; lane enabled; owner holds the owner role and the briefing view (T-231c)'),
  ('core.briefing_coverage', 'Home coverage strip: answers only the caller''s comms/calendar views at aal2; connection facts, no tokens (T-231a)'),
  ('core.briefing_save_own', 'Owner briefing writer: aal2 + owner role + briefing view, owner = auth.uid(), 2-minute cooldown under an advisory lock (T-231c)'),
  ('core.home_finance_context', 'Home finance: QuickBooks connection facts and mapping for a caller with the finance view at aal2 only (T-233)'),
  ('core.allowed_lanes', 'reads memberships for RLS; own uid at aal2 only (T-012)'),
  ('core.has_lane_role', 'role check for actions; own uid at aal2 only (T-012)'),
  ('core.lane_config_public', 'non-sensitive config subset for lane members (T-011)'),
  ('audit.log', 'the only audit write path; service_role only (T-014)'),
  ('core.mfa_verification_attempt', 'Supabase Auth MFA hook; supabase_auth_admin only (T-019)'),
  ('core.connection_token_store', 'writes the Vault; service_role only, lane-checked (T-032)'),
  ('core.connection_token_read', 'reads the Vault; service_role only, lane-checked (T-032)'),
  ('core.connection_token_rotate', 'updates the Vault; service_role only, lane-checked (T-032)'),
  ('core.connection_token_revoke', 'deletes from the Vault and disconnects; service_role only, lane-checked (T-032)'),
  ('core.connection_activate_composio', 'activates a composio connection without a token row; service_role only, lane-checked, identity validated, audited (T-219)'),
  ('core.oauth_state_bind', 'service_role only: binds a Composio toolkit + account id to the user''s own pending connect state, once (T-219)'),
  ('core.connections_no_orphan_secret', 'trigger only: reads the private Vault mapping on status changes (T-032)'),
  ('core.oauth_state_create', 'starts a connect; owner/admin_technical of the lane at aal2 only (T-035)'),
  ('core.oauth_state_consume', 'finishes a connect; own unexpired state, same lane, role re-checked (T-035)'),
  ('core.source_records_upsert', 'writes the private raw.source_records; service_role only, lane-checked against the connection (T-039)'),
  ('core.webhook_resolve_connection', 'webhook receiver: the usable connection of a lane for a provider account; service_role only (T-036)'),
  ('core.webhook_event_claim', 'webhook receiver: records an event once per (lane, provider, event id); service_role only, lane-checked (T-036)'),
  ('core.webhook_event_mark', 'webhook receiver: received -> enqueued | failed, lane-bound; service_role only (T-036)'),
  ('core.webhook_events_purge', 'webhook receipt retention, per lane, minimum 7 days; service_role only (T-036)'),
  ('core.connector_api_errors_purge', 'retention: deletes a lane''s connector API errors older than a fixed 90 days; service_role only, enabled lanes only (T-196)'),
  ('core.source_records_purge_bodies', 'retention: deletes a lane''s stored raw bodies when store_content_bodies is off; service_role only, lane-checked (T-042)'),
  ('core.sync_cursor_get', 'reads the private sync cursor table; service_role only, lane-checked (T-063)'),
  ('core.sync_cursor_reset', 'deletes a sync cursor; service_role only, lane-checked (T-063)'),
  ('core.sync_cursor_put', 'compare-and-swap write of a sync cursor; service_role only, lane-checked, usable connections only (T-038)'),
  ('core.comms_mail_apply_page', 'applies one Gmail metadata page and its cursor atomically; service_role only, lane-checked against a usable Google connection (T-063)'),
  ('core.cal_events_apply_page', 'applies one Google Calendar metadata page and its cursor atomically; service_role only, lane-checked against a usable Google connection (T-064)'),
  ('comms.message_summary_guard', 'trigger only: reads lane policy and memberships to validate a summary and its approver (T-061)'),
  ('fin.report_cache_guard', 'trigger only: calls the private raw.payload_scan on a report payload; reads and writes nothing (T-055)'),
  ('core.fin_qbo_normalize', 'QuickBooks normalizer: reads the private raw.source_records of one connection and writes fin.*; service_role only, lane-checked against a usable QuickBooks connection (T-056)'),
  ('core.home_calendar_status', 'Home: returns only no_access | not_connected | connected; reads core.connections for callers with the calendar view at aal2 (T-200)'),
  ('core.ai_chat_turn', 'chat route gate: memberships, lane_policies, lane_config and the private turn counter for auth.uid() at aal2; returns allowed/reason/categories (T-105)'),
  ('core.ai_tool_categories', 'assistant tool categories for auth.uid() at aal2 with the assistant view; categories only (T-105)'),
  ('core.ai_tool_gate', 'assistant policy gate: reads memberships, lane_policies and the private rate table for auth.uid() at aal2 only; returns a reason code, no data (T-101)'),
  ('brain.document_save', 'brain page writer: aal2 + owner role + own pages only (addressed by auth.uid()), optimistic version, secret scan, keeps 20 versions (T-210)'),
  ('brain.employee_save', 'employee profile writer: aal2 + owner role + own profiles only, optimistic version, secret scan (T-210)'),
  ('brain.skill_save', 'skill writer: aal2 + owner role + own skills only, optimistic version, secret scan (T-210)'),
  ('brain.import_decide', 'import review: aal2 + owner role + own open import only; finish deletes the candidates (T-210)'),
  ('brain.section_complete', 'setup-interview completion writer: aal2 + owner role + own rows only (auth.uid()), known section ids, idempotent (T-227)'),
  ('brain.import_create', 'import writer: aal2 + owner role + own rows only (auth.uid()), extraction sources, 1-100 candidates, 20 imports/hour, four interview pages, lanes the caller may open, NL candidates keep no quote (T-220)'),
  ('core.brain_import_purge', 'retention: deletes a lane''s import candidates older than 23 h and closes stale imports; service_role only, lane-checked (T-210)'),
  ('act.propose', 'creates an email proposal; service_role only; refuses unless store_outbound_drafts, deny-listed types, other lanes'' connections, more than 20 pending (T-232)'),
  ('core.act_claim_open', 'the Gmail writer''s pre-send check: executing action, open claim, approved hash and approver; service_role only (T-232 review H1)'),
  ('act.supersede', 'edit = new proposal, old one invalidated and purged; service_role only, lane-checked (T-232)'),
  ('act.approve', 'approves the exact hash: aal2, TOTP step-up (amr), owner of the lane, approvals_live, lane policy type, compose grant; authenticated (T-232)'),
  ('act.reject', 'rejects a pending proposal; aal2 + owner of the lane, reason required (T-232)'),
  ('act.claim_execution', 'approved -> executing with the single claim; service_role only, re-checks every gate (T-232)'),
  ('act.claim_sent', 'records the provider id after the external write; service_role only, open claim required (T-232)'),
  ('act.mark_verified', 'executing -> verified; service_role only (T-232)'),
  ('act.mark_failed', 'executing -> failed; service_role only (T-232)'),
  ('act.expire_stale', 'expires proposed/approved actions past expires_at; service_role only, lane-scoped (T-232)'),
  ('act.stuck_actions', 'lists executing actions older than the lane threshold with their claim state; service_role only, lane-scoped (T-192)'),
  ('act.reconcile_verified', 'reconciler: executing -> verified; service_role only, conditional on executing + due + claim, never creates a claim (T-192)'),
  ('act.action_state', 'status and failure code of one action, lane-scoped; service_role only; lets a late execute see it was finished by the reconciler (T-192)'),
  ('act.reconcile_failed', 'reconciler: executing -> failed (mismatch / outcome_unknown); service_role only, conditional on executing + due + claim (T-192)'),
  ('act.withdraw_proposed', 'withdraws a still-pending job proposal (proposed -> invalidated); service_role only (T-234)'),
  ('brief.news_digests_guard', 'insert/update trigger: lane enabled, a refresh needs an owner with the briefing view, pending -> final only, identity fixed, item shape and https links (T-234 part 4)'),
  ('brief.news_reserve', 'news gates before any model call: web category, news.enabled, once-a-day schedule, 1-per-hour refresh, monthly cap from lane_config; service_role and the definer wrappers only (T-234 part 4)'),
  ('core.news_begin_refresh', 'owner Refresh: aal2 + lane owner + briefing view, then brief.news_reserve (rate limit and cap in SQL) (T-234 part 4)'),
  ('core.news_finish_own', 'owner Refresh result: aal2 + lane owner + briefing view, own pending refresh row only (T-234 part 4)'),
  ('core.news_spend', 'news spend and last status (no items): aal2, lane owner or admin_technical (T-234 part 4)'),
  ('brief.news_cap', 'the lane''s monthly news cap read from lane_config; no API role may execute it (T-234 part 4)'),
  ('core.news_enabled', 'is news configured for the lane (boolean only): aal2 + briefing view, else false (T-234 part 4)'),
  ('brief.briefing_claim', 'briefing run gates: stale (3 h), one running per lane, 6 per lane and New York day, Regenerate once per 30 min, 10 min pause; no API role may execute it (T-235)'),
  ('brief.briefing_runs_close', 'marks the owner''s open run claims finished; called by the briefing saves; service_role only (T-235)'),
  ('core.briefing_claim_auto', 'Home auto-summary claim: aal2 + lane owner + briefing view, then brief.briefing_claim (T-235)'),
  ('core.briefing_claim_regenerate', 'owner Regenerate claim: aal2 + lane owner + briefing view, then brief.briefing_claim (30-min limit, daily cap) (T-235)'),
  ('core.briefing_claim_schedule', 'the 06:30 job records its run; service_role only, owner role and view re-checked; never gated (T-235)'),
  ('core.briefing_run_state', 'Home: a run is open, last Regenerate, runs today, newest briefing times; aal2 + lane owner + briefing view, else no row (T-235)'),
  ('core.briefing_claim_release', 'the claiming owner releases their own open run claim (closed as lost); aal2 + lane owner + briefing view, own row only (T-235)'),
  ('brief.briefing_runs_purge', 'retention of run claims older than N New York days (floor 1); service_role only (T-235)'),
  ('core.briefing_claim_refresh', 'the briefing.refresh job claims a run after new mail through the same gates as Home auto; service_role only, owner role and view re-checked (T-238)'),
  ('core.briefing_claim_refresh_close', 'the briefing.refresh job finishes the owner''s open auto claim; service_role only (T-238)'),
  ('core.job_failure_record', 'a scheduled function failed: increments its streak, alerts once at 3; service_role only (T-238)'),
  ('core.job_failure_clear', 'a scheduled function succeeded: resets its streak; service_role only (T-238)'),
  ('core.sync_now_claim', 'Sync now rate limit (one per lane per 2 minutes): aal2 + owner or admin_technical + connections view (T-238)'),
  ('core.connections_clear_job_failures', 'trigger: a connection leaving active/degraded drops its own job_failures rows (same lane and id only); no API execute (T-238 review M1)');

-- App functions authenticated may execute (callable through the API). Each one is reviewed.
create temp table authenticated_exec_ok (name text primary key, why text not null) on commit drop;
insert into authenticated_exec_ok values
  ('core.sync_now_claim', 'Sync now rate limit; definer, checks aal2, the role and the connections view itself (T-238)'),
  ('core.briefing_coverage', 'Home briefing coverage; definer, checks the caller''s views itself (T-231a)'),
  ('core.briefing_events', 'Home calendar; invoker, RLS on cal.event_index applies (T-231a)'),
  ('core.briefing_threads', 'Home attention and money threads; invoker, RLS on comms.message_index applies (T-231b)'),
  ('core.briefing_latest', 'Home AI briefing: the caller''s own latest; invoker, RLS on brief.briefings applies (T-231c)'),
  ('core.briefing_last_failure', 'Home briefing failure reason: the caller''s newest failed attempt; invoker, RLS on brief.briefings applies (T-234)'),
  ('core.briefing_save_own', 'Saves the caller''s own briefing; checks aal2, owner role and the briefing view itself (T-231c)'),
  ('core.home_finance', 'Home finance figures; invoker over fin tables (T-233)'),
  ('core.home_finance_detail', 'Home finance detail (bills due, AR aging, oldest invoices); invoker over fin tables (T-237)'),
  ('core.finance_pnl', 'Finance page net income for week, month or year to date; invoker over fin.report_cache (T-244)'),
  ('core.finance_pnl_window', 'P&L extraction shared by home_finance and finance_pnl; invoker over fin.report_cache (T-244)'),
  ('core.finance_overview', 'Finance page open AR total and cached report metadata; invoker over fin tables (T-244)'),
  ('core.home_finance_context', 'Home finance context; definer, checks the finance view at aal2 itself (T-233)'),
  ('core.allowed_lanes', 'used by every RLS policy'),
  ('core.has_lane_role', 'role checks (requireRole)'),
  ('core.lane_config_public', 'public config subset'),
  ('core.view_names', 'pure list'),
  ('core.viewer_view_names', 'pure list'),
  ('core.role_views', 'pure mapping'),
  ('core.oauth_state_create', 'connect start; checks role and aal2 itself (T-035)'),
  ('core.oauth_state_consume', 'connect callback; own state only (T-035)'),
  ('fin.et_date', 'pure calendar function (T-080)'),
  ('fin.month_start', 'pure calendar function (T-080)'),
  ('fin.next_month_start', 'pure calendar function (T-080)'),
  ('fin.ytd_start', 'pure calendar function (T-080)'),
  ('fin.business_week', 'pure calendar function (T-080)'),
  ('fin.month_range', 'pure calendar function (T-080)'),
  ('fin.ytd_range', 'pure calendar function (T-080)'),
  ('fin.mtd_range', 'pure calendar function (T-080)'),
  ('core.home_calendar_status', 'Home calendar state; definer, aal2 + calendar view checked inside (T-200)'),
  ('core.ai_chat_turn', 'chat route gate; aal2, role, assistant view, categories and turn limit checked inside (T-105)'),
  ('core.ai_tool_categories', 'caller''s assistant tool categories; aal2 + assistant view checked inside (T-105)'),
  ('core.ai_tool_gate', 'assistant policy gate; checks aal2, membership, role, lane, category, views and rate for auth.uid() itself (T-101)'),
  ('core.home_meetings', 'Home meetings; invoker, RLS on cal applies, window capped (T-200)'),
  ('core.home_mail_attention', 'Home mail counts; invoker, RLS on comms applies (T-200)'),
  ('core.inbox_messages', 'Inbox list metadata; invoker, RLS on comms applies (T-202)'),
  ('core.inbox_message_ref', 'one visible message before the live body read; invoker, RLS on comms applies (T-202)'),
  ('brain.document_save', 'brain page writer; checks aal2, owner role and ownership itself (T-210)'),
  ('brain.employee_save', 'employee profile writer; checks aal2, owner role and ownership itself (T-210)'),
  ('brain.skill_save', 'skill writer; checks aal2, owner role and ownership itself (T-210)'),
  ('brain.import_decide', 'import review; checks aal2, owner role and ownership itself (T-210)'),
  ('core.brain_home_lane', 'brain: the lane holding the caller''s About-Me; invoker, RLS applies (T-210)'),
  ('core.brain_documents_list', 'brain: page metadata; invoker, RLS applies (T-210)'),
  ('core.brain_document_get', 'brain: one page; invoker, RLS applies (T-210)'),
  ('core.brain_document_versions', 'brain: own saved versions; invoker, RLS applies (T-210)'),
  ('core.brain_document_save', 'brain: wrapper over brain.document_save; invoker (T-210)'),
  ('core.brain_employees_list', 'brain: employee profiles; invoker, RLS applies (T-210)'),
  ('core.brain_employee_save', 'brain: wrapper over brain.employee_save; invoker (T-210)'),
  ('core.brain_skills_list', 'brain: skills; invoker, RLS applies (T-210)'),
  ('core.brain_skill_save', 'brain: wrapper over brain.skill_save; invoker (T-210)'),
  ('core.brain_import_decide', 'brain: wrapper over brain.import_decide; invoker (T-210)'),
  ('brain.section_complete', 'setup-interview completion writer; checks aal2, owner role and ownership itself (T-227)'),
  ('brain.import_create', 'import writer; checks aal2, owner role and ownership itself (T-220)'),
  ('core.brain_import_create', 'brain: wrapper over brain.import_create; invoker (T-220)'),
  ('core.brain_import_candidates', 'brain: the caller''s candidates of one open import; invoker, RLS applies (T-220)'),
  ('core.brain_section_completions', 'brain: the caller''s completed setup sections; invoker, RLS applies (T-227)'),
  ('core.brain_section_complete', 'brain: wrapper over brain.section_complete; invoker (T-227)'),
  ('act.approve', 'approval writer; checks aal2, step-up, owner role, hash and gates itself (T-232)'),
  ('act.reject', 'rejection writer; checks aal2 and owner role itself (T-232)'),
  ('core.act_approve', 'approvals: wrapper over act.approve; invoker (T-232)'),
  ('core.act_reject', 'approvals: wrapper over act.reject; invoker (T-232)'),
  ('core.act_list', 'approvals: the lane''s actions; invoker, RLS applies (T-232)'),
  ('core.act_pending_qbo_disconnects', 'Settings: ids of pending qbo.disconnect proposals; invoker, RLS applies, read-only (T-197)'),
  ('core.act_get', 'approvals: one action; invoker, RLS applies (T-232)'),
  ('core.act_pending_count', 'approvals: pending count for Home; invoker, RLS applies (T-232)'),
  ('core.act_reply_state', 'reply drawer: pending proposal, in-doubt block and last verified reply for one thread; invoker, RLS applies (T-234)'),
  ('act.is_unknown_failure', 'pure helper: is a failure code one after which the email may exist (T-234)'),
  ('core.news_latest', 'Home GovCon news: the newest digest; invoker, RLS on brief.news_digests applies (T-234 part 4)'),
  ('core.news_begin_refresh', 'owner Refresh: checks aal2, owner role and the briefing view itself; rate limit and cap in SQL (T-234 part 4)'),
  ('core.news_finish_own', 'owner Refresh result; checks aal2, owner role, view and own pending row itself (T-234 part 4)'),
  ('core.news_spend', 'news spend and last status; checks aal2 and owner/admin_technical itself (T-234 part 4)'),
  ('core.news_enabled', 'is news configured for the lane; boolean only, checks aal2 and the briefing view itself (T-234 part 4)'),
  ('core.briefing_claim_auto', 'Home auto-summary claim; checks aal2, owner role and the briefing view itself; gates in SQL (T-235)'),
  ('core.briefing_claim_regenerate', 'owner Regenerate claim; checks aal2, owner role and the briefing view itself; 30-min limit and daily cap in SQL (T-235)'),
  ('core.briefing_run_state', 'Home run state for the owner; checks aal2, owner role and the briefing view itself, else no row (T-235)'),
  ('core.briefing_claim_release', 'the claiming owner releases their own open claim; checks aal2, owner role, the briefing view and the claim owner itself (T-235)');

create temp view app_objects as
  select c.oid, format('%s.%s', n.nspname, c.relname) as name, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and n.nspname not in (select name from platform_schemas)
    and n.nspname !~ '^pg_(temp|toast_temp)_';
create temp view app_tables as select * from app_objects where relkind in ('r', 'p');
create temp view app_functions as
  select p.oid, format('%s.%s', n.nspname, p.proname) as name, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in (select name from platform_schemas) and n.nspname !~ '^pg_(temp|toast_temp)_';

-- ---------------------------------------------------------------- tables
select is(
  array(select t.name from app_tables t
        where not exists (select 1 from pg_attribute a where a.attrelid = t.oid and a.attname = 'lane_id' and not a.attisdropped)
          and t.name not in (select name from no_lane_id_ok)
        order by 1),
  '{}'::text[],
  'every app table has lane_id (or is on the reviewed control-plane list)'
);
select is(
  array(select t.name from app_tables t join pg_class c on c.oid = t.oid where not c.relrowsecurity order by 1),
  '{}'::text[],
  'every app table has RLS enabled'
);
select is(
  array(select t.name from app_tables t
        where not exists (select 1 from pg_policy p where p.polrelid = t.oid)
          and not (t.name in (select name from private_table_ok)
                   and not has_table_privilege('authenticated', t.oid, 'select, insert, update, delete')
                   and not has_table_privilege('service_role', t.oid, 'select, insert, update, delete'))
        order by 1),
  '{}'::text[],
  'every app table has at least one policy (or is a reviewed private table without API grants)'
);
select is(
  array(select t.name from app_tables t
        where t.name not in (select name from custom_policy_ok)
          and t.name not in (select name from private_table_ok)
          and not (
            (select count(*) from pg_policy p where p.polrelid = t.oid and p.polpermissive) = 1
            and exists (
              select 1 from pg_policy p
              where p.polrelid = t.oid and p.polpermissive and p.polcmd = 'r'
                and p.polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[]
                and pg_get_expr(p.polqual, p.polrelid) in (select pg_temp.standard_lane_qual(v) from unnest(core.view_names()) v)))
        order by 1),
  '{}'::text[],
  'lane tables have exactly one permissive policy: SELECT for authenticated with the exact standard expression'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where p.polcmd in ('r', '*') and pg_get_expr(p.polqual, p.polrelid) !~ '^\(\(\( SELECT \(auth\.jwt\(\) ->> ''aal''::text\)\) = ''aal2''::text\) AND '
        order by 1),
  '{}'::text[],
  'every SELECT policy (custom ones too) starts with the aal2 requirement as a conjunct'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where p.polcmd in ('a', 'w', 'd', '*') and t.name not in (select name from user_dml_ok) order by 1),
  '{}'::text[],
  'no write (or ALL) policy outside the reviewed list'
);
select is(
  array(select distinct t.name from app_tables t join pg_policy p on p.polrelid = t.oid
        where 0 = any (p.polroles) or (select oid from pg_roles where rolname = 'anon') = any (p.polroles)
        order by 1),
  '{}'::text[],
  'no policy applies to public or anon'
);
select is(
  array(select t.name from app_tables t
        where (has_table_privilege('authenticated', t.oid, 'insert, update, delete, truncate')
               or has_any_column_privilege('authenticated', t.oid, 'insert, update'))
          and t.name not in (select name from user_dml_ok)
        order by 1),
  '{}'::text[],
  'authenticated has no table- or column-level DML on app tables (or is on the reviewed list)'
);

-- ---------------------------------------------------------------- other relations
select is(
  array(select o.name from app_objects o
        where o.relkind <> 'S'
          and (has_table_privilege('anon', o.oid, 'select, insert, update, delete, truncate, references, trigger')
               or has_any_column_privilege('anon', o.oid, 'select, insert, update, references'))
        order by 1),
  '{}'::text[],
  'anon has no privilege on any app table, view or other relation'
);
select is(
  array(select o.name from app_objects o
        where o.relkind in ('m', 'f')
          and (has_table_privilege('authenticated', o.oid, 'select') or has_any_column_privilege('authenticated', o.oid, 'select'))
          and o.name not in (select name from unprotected_read_ok)
        order by 1),
  '{}'::text[],
  'no materialized view or foreign table is readable by authenticated (they bypass RLS)'
);
select is(
  array(select o.name from app_objects o join pg_class c on c.oid = o.oid
        where o.relkind = 'v'
          and not exists (select 1 from unnest(coalesce(c.reloptions, '{}')) r
                          where lower(r) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes'))
        order by 1),
  '{}'::text[],
  'every app view is security_invoker'
);
select is(
  array(select o.name from app_objects o
        where o.relkind = 'S' and (has_sequence_privilege('anon', o.oid, 'usage, select, update')
                                   or has_sequence_privilege('authenticated', o.oid, 'usage, select, update'))
        order by 1),
  '{}'::text[],
  'anon and authenticated have no privilege on app sequences'
);
select is(
  array(select format('%s.%s', n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'extensions' and c.relkind in ('r', 'p', 'v', 'm', 'f') and pg_get_userbyid(c.relowner) <> 'supabase_admin'
        order by 1),
  '{}'::text[],
  'no app relations hide in the extensions schema'
);

-- ---------------------------------------------------------------- functions
select is(
  array(select f.name from app_functions f
        where not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c = 'search_path=""')
        order by 1),
  '{}'::text[],
  'every app function pins an empty search_path'
);
select is(
  array(select f.name from app_functions f where has_function_privilege('anon', f.oid, 'execute') order by 1),
  '{}'::text[],
  'anon cannot execute any app function'
);
select is(
  array(select distinct f.name from app_functions f where f.prosecdef and f.name not in (select name from security_definer_ok) order by 1),
  '{}'::text[],
  'every security-definer function is on the reviewed list'
);
select is(
  array(select distinct f.name from app_functions f
        where has_function_privilege('authenticated', f.oid, 'execute') and f.name not in (select name from authenticated_exec_ok)
        order by 1),
  '{}'::text[],
  'authenticated can execute only reviewed app functions'
);

-- ---------------------------------------------------------------- exception lists stay current
select is(
  array(select e.name from (select name from no_lane_id_ok union select name from custom_policy_ok
                            union select name from user_dml_ok union select name from unprotected_read_ok
                            union select name from private_table_ok) e
        where to_regclass(e.name) is null order by 1),
  '{}'::text[],
  'no stale relation entries in the exception lists'
);
select is(
  array(select e.name from (select name from security_definer_ok union select name from authenticated_exec_ok) e
        where not exists (select 1 from app_functions f where f.name = e.name) order by 1),
  '{}'::text[],
  'no stale function entries in the exception lists'
);

-- The helper agrees on a known lane table.
select pg_temp.has_standard_lane_policy('core.lane_policies', 'lane_policies');

select * from finish();
rollback;
