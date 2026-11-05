-- T-061: comms and calendar index tables (architecture §6 M5/M6, §7 retention). comms.message_index holds mail/chat
-- METADATA only; cal.event_index holds event metadata only. Bodies, snippets, previews and event descriptions are
-- fetched live from the provider when opened or analysed and are never stored here (rule 6): no such column exists, and
-- the pgTAP test fails if one is added. `summary` is the one derived text; it can only be set together with an approval
-- marker (who approved it and when), enforced by a check constraint.
--
-- Read: standard lane policy, AAL2, own lane only. message_index on the 'comms' view, event_index on the 'calendar' view.
-- Write: service_role only (sync jobs, T-064/T-065/T-067/T-068 and the classifier); authenticated has no DML.
-- Every row belongs to a Google or Microsoft connection of the SAME lane (composite FK), so a lane cannot index
-- another lane's mailbox. Provider ids are unique per (lane, connection[, calendar]) for idempotent upsert.
-- Retention: comms.message_index_purge (default and maximum = the lane policy's retention_days: PKG 90, NL 30) and
-- cal.event_index_purge (default and maximum 180 days) for the T-042 retention job to call, one lane at a time.
-- New schemas comms and cal are not exposed to PostgREST (like fin); exposing them is a later UI task.

create schema comms;
create schema cal;
revoke all on schema comms from public, anon;
revoke all on schema cal from public, anon;
grant usage on schema comms to authenticated, service_role;
grant usage on schema cal to authenticated, service_role;

-- Identity columns of an index row never change (a row cannot move to another lane, connection or provider object).
-- One shared guard (column names come from the trigger arguments); the schema and table come from the trigger.
create function core.forbid_identity_change() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if pg_catalog.to_jsonb(new) -> v_col is distinct from pg_catalog.to_jsonb(old) -> v_col then
      raise exception '%.%: % cannot be changed', tg_table_schema, tg_table_name, v_col using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function core.forbid_identity_change() from public, anon, authenticated;

-- Shape checks for the jsonb people lists: an array of at most 200 objects holding only the allowed keys, all strings
-- (and for attendees a known response value). Addresses and display names only; nothing else can ride along.
create function comms.recipients_ok(p jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p) = 'array'
    and pg_catalog.jsonb_array_length(p) <= 200
    and pg_catalog.octet_length(p::text) <= 65536
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p) e
      where pg_catalog.jsonb_typeof(e) <> 'object'
         or exists (select 1 from pg_catalog.jsonb_object_keys(e) k where k not in ('address', 'name'))
         or pg_catalog.jsonb_typeof(e -> 'address') is distinct from 'string'
         or length(e ->> 'address') not between 3 and 320
         or (e ? 'name' and (pg_catalog.jsonb_typeof(e -> 'name') <> 'string' or length(e ->> 'name') > 200))
    );
$$;
revoke all on function comms.recipients_ok(jsonb) from public, anon, authenticated;
-- Check constraints run as the writing role, so the writer needs execute (pure function, no data access).
grant execute on function comms.recipients_ok(jsonb) to service_role;

create function cal.attendees_ok(p jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p) = 'array'
    and pg_catalog.jsonb_array_length(p) <= 500
    and pg_catalog.octet_length(p::text) <= 131072
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p) e
      where pg_catalog.jsonb_typeof(e) <> 'object'
         or exists (select 1 from pg_catalog.jsonb_object_keys(e) k where k not in ('email', 'name', 'response'))
         or pg_catalog.jsonb_typeof(e -> 'email') is distinct from 'string'
         or length(e ->> 'email') not between 3 and 320
         or (e ? 'name' and (pg_catalog.jsonb_typeof(e -> 'name') <> 'string' or length(e ->> 'name') > 200))
         or (e ? 'response' and (pg_catalog.jsonb_typeof(e -> 'response') <> 'string'
                                 or (e ->> 'response') not in ('accepted', 'declined', 'tentative', 'needs_action')))
    );
$$;
revoke all on function cal.attendees_ok(jsonb) from public, anon, authenticated;
grant execute on function cal.attendees_ok(jsonb) to service_role;

create function comms.labels_ok(p text[]) returns boolean
language sql immutable
set search_path = ''
as $$
  select cardinality(p) <= 50
    and not exists (select 1 from pg_catalog.unnest(p) l where l is null or length(l) not between 1 and 256 or l ~ '[[:cntrl:]]');
$$;
revoke all on function comms.labels_ok(text[]) from public, anon, authenticated;
grant execute on function comms.labels_ok(text[]) to service_role;

-- ---------------------------------------------------------------- comms.message_index
create table comms.message_index (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  -- The provider's message id and thread/conversation id.
  message_id text not null check (length(message_id) between 1 and 512 and message_id !~ '[[:cntrl:]]'),
  thread_id text check (length(thread_id) between 1 and 512 and thread_id !~ '[[:cntrl:]]'),
  -- Link to open the message at the provider (https only).
  source_url text check (source_url ~ '^https://' and length(source_url) <= 2048 and source_url !~ '[[:cntrl:][:space:]]'),
  -- People: addresses and display names only.
  from_address text check (length(from_address) between 3 and 320 and from_address !~ '[[:cntrl:]]'),
  from_name text check (length(from_name) <= 200 and from_name !~ '[[:cntrl:]]'),
  to_recipients jsonb not null default '[]' check (comms.recipients_ok(to_recipients)),
  cc_recipients jsonb not null default '[]' check (comms.recipients_ok(cc_recipients)),
  subject text check (length(subject) <= 998 and subject !~ '[[:cntrl:]]'),
  received_at timestamptz not null,
  -- Flags from the provider.
  is_read boolean not null default false,
  is_starred boolean not null default false,
  is_important boolean not null default false,
  has_attachments boolean not null default false,
  folder text check (length(folder) between 1 and 256 and folder !~ '[[:cntrl:]]'),
  labels text[] not null default '{}' check (comms.labels_ok(labels)),
  -- Priority and classification (derived by the classifier from lane_config priority rules; never from stored bodies).
  priority_score smallint check (priority_score between 0 and 100),
  needs_reply boolean not null default false,
  category text check (category ~ '^[a-z][a-z0-9_]{0,63}$'),
  commitment_candidate boolean not null default false,
  classifier_model text check (length(classifier_model) between 1 and 128),
  classifier_version text check (length(classifier_version) between 1 and 64),
  classified_at timestamptz,
  -- Optional approved summary. Present only with its approval marker.
  summary text check (length(summary) between 1 and 2000),
  summary_approved_at timestamptz,
  summary_approved_by uuid references core.users (id) on update restrict on delete restrict,
  -- Set when the provider reports the message removed; the row stays until retention purges it.
  deleted boolean not null default false,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_index_summary_approved check (
    (summary is null and summary_approved_at is null and summary_approved_by is null)
    or (summary is not null and summary_approved_at is not null and summary_approved_by is not null)),
  constraint message_index_classified check (
    (classified_at is null and classifier_model is null and classifier_version is null and priority_score is null)
    or (classified_at is not null and classifier_model is not null)),
  unique (lane_id, connection_id, message_id),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict
);
comment on table comms.message_index is
  'Mail/chat metadata index (T-061): no body, snippet or preview column by design (rule 6). summary requires an approval marker.';
comment on column comms.message_index.deleted is
  'Set when the provider reports the message removed (Gmail messagesDeleted, Graph @removed). Trash stays a label, not this flag.';
create index message_index_lane_received_idx on comms.message_index (lane_id, received_at desc);
create index message_index_connection_idx on comms.message_index (connection_id);
create index message_index_thread_idx on comms.message_index (lane_id, connection_id, thread_id) where thread_id is not null;
create index message_index_lane_needs_reply_idx on comms.message_index (lane_id, priority_score desc nulls last)
  where needs_reply and not deleted;
create index message_index_approver_idx on comms.message_index (summary_approved_by) where summary_approved_by is not null;

-- ---------------------------------------------------------------- cal.event_index
create table cal.event_index (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null check (provider in ('google', 'microsoft')),
  -- Provider calendar id and event id (event ids are unique per calendar).
  calendar_id text not null check (length(calendar_id) between 1 and 512 and calendar_id !~ '[[:cntrl:]]'),
  event_id text not null check (length(event_id) between 1 and 512 and event_id !~ '[[:cntrl:]]'),
  ical_uid text check (length(ical_uid) between 1 and 512 and ical_uid !~ '[[:cntrl:]]'),
  source_url text check (source_url ~ '^https://' and length(source_url) <= 2048 and source_url !~ '[[:cntrl:][:space:]]'),
  title text check (length(title) <= 1000 and title !~ '[[:cntrl:]]'),
  location text check (length(location) <= 1000 and location !~ '[[:cntrl:]]'),
  organizer_email text check (length(organizer_email) between 3 and 320 and organizer_email !~ '[[:cntrl:]]'),
  organizer_name text check (length(organizer_name) <= 200 and organizer_name !~ '[[:cntrl:]]'),
  -- Instants. Null only for a cancelled stub (the provider sends cancelled instances without times).
  start_at timestamptz,
  end_at timestamptz,
  all_day boolean not null default false,
  -- All-day events: calendar dates, end_date EXCLUSIVE (a one-day event on the 5th has end_date the 6th), as the
  -- providers send them. start_at/end_at still hold the instants resolved in the event's timezone (midnight there).
  start_date date,
  end_date date,
  -- IANA zone name of the event (display and recurrence), not an offset.
  timezone text check (timezone ~ '^[A-Za-z0-9_+./-]{1,64}$'),
  attendees jsonb not null default '[]' check (cal.attendees_ok(attendees)),
  status text not null default 'confirmed' check (status in ('confirmed', 'tentative', 'cancelled')),
  -- Recurrence: the series master's id and, for an exception, the start the instance had in the series.
  recurring_event_id text check (length(recurring_event_id) between 1 and 512 and recurring_event_id !~ '[[:cntrl:]]'),
  original_start_at timestamptz,
  online_meeting_url text check (online_meeting_url ~ '^https://' and length(online_meeting_url) <= 2048
                                 and online_meeting_url !~ '[[:cntrl:][:space:]]'),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- status 'cancelled' is the single "gone" state for events.
  constraint event_index_times check (status = 'cancelled' or (start_at is not null and end_at is not null)),
  constraint event_index_order check (start_at is null or end_at is null or end_at >= start_at),
  constraint event_index_all_day check (not all_day or (start_date is not null and end_date is not null and end_date > start_date)),
  unique (lane_id, connection_id, calendar_id, event_id),
  foreign key (connection_id, lane_id, provider) references core.connections (id, lane_id, provider)
    on update restrict on delete restrict
);
comment on table cal.event_index is
  'Calendar event metadata index (T-061): no description or body column by design (rule 6).';
create index event_index_lane_start_idx on cal.event_index (lane_id, start_at);
create index event_index_lane_end_idx on cal.event_index (lane_id, end_at);
create index event_index_connection_idx on cal.event_index (connection_id);
create index event_index_recurring_idx on cal.event_index (lane_id, connection_id, recurring_event_id) where recurring_event_id is not null;

-- ---------------------------------------------------------------- triggers, RLS, grants
create trigger message_index_set_updated_at before update on comms.message_index
  for each row execute function core.set_updated_at();
create trigger message_index_identity before update on comms.message_index
  for each row execute function core.forbid_identity_change('lane_id', 'connection_id', 'provider', 'message_id');
create trigger event_index_set_updated_at before update on cal.event_index
  for each row execute function core.set_updated_at();
create trigger event_index_identity before update on cal.event_index
  for each row execute function core.forbid_identity_change('lane_id', 'connection_id', 'provider', 'calendar_id', 'event_id');

-- Summary guard. A summary is derived text: (a) a changed summary needs a NEW approval time (an old approval never
-- carries over to different text); (b) the lane's policy must allow email content to the model; (c) the approver must be
-- a member of the row's lane. Definer: reads the policy and memberships, which the writer role may not own.
create function comms.message_summary_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.summary is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.summary is distinct from old.summary
     and new.summary_approved_at is not distinct from old.summary_approved_at then
    raise exception 'comms.message_index: a changed summary needs a new approval time' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' or new.summary is distinct from old.summary
     or new.summary_approved_by is distinct from old.summary_approved_by then
    if not exists (select 1 from core.lane_policies lp
                   where lp.lane_id = new.lane_id and 'email' = any (lp.llm_allowed_categories)) then
      raise exception 'comms.message_index: lane policy does not allow email summaries' using errcode = '23514';
    end if;
    if not exists (select 1 from core.memberships m
                   where m.user_id = new.summary_approved_by and m.lane_id = new.lane_id) then
      raise exception 'comms.message_index: the approver is not a member of this lane' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function comms.message_summary_guard() from public, anon, authenticated;
create trigger message_index_summary_guard before insert or update on comms.message_index
  for each row execute function comms.message_summary_guard();

alter table comms.message_index enable row level security;
alter table cal.event_index enable row level security;

-- The standard lane policy (architecture §5.4); the catalog test checks this exact shape.
create policy message_index_select on comms.message_index
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'comms'))::text[])
  );
create policy event_index_select on cal.event_index
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'calendar'))::text[])
  );

revoke all on comms.message_index from public, anon, authenticated, service_role;
revoke all on cal.event_index from public, anon, authenticated, service_role;
grant select on comms.message_index to authenticated;
grant select on cal.event_index to authenticated;
grant select, insert, update, delete on comms.message_index to service_role;
grant select, insert, update, delete on cal.event_index to service_role;
-- New functions in these schemas are not executable by PUBLIC unless granted (as in fin).
alter default privileges in schema comms revoke execute on functions from public;
alter default privileges in schema cal revoke execute on functions from public;

-- ---------------------------------------------------------------- purge (retention)
-- Deletes one lane's rows older than the keep interval. p_keep null = the lane policy's retention_days (PKG 90, NL 30).
-- Messages age by received_at; the floor is 1 day. T-042's retention job calls this per lane.
create function comms.message_index_purge(p_lane text, p_keep interval default null)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_policy interval;
  v_keep interval;
  v_n integer;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  select pg_catalog.make_interval(days => lp.retention_days) into v_policy
  from core.lane_policies lp where lp.lane_id = p_lane;
  if v_policy is null then
    raise exception 'no lane policy for this lane' using errcode = '22023';
  end if;
  -- A caller can keep less than the lane policy allows, never more.
  v_keep := least(coalesce(p_keep, v_policy), v_policy);
  if v_keep < interval '1 day' then
    raise exception 'keep at least 1 day of message metadata' using errcode = '22023';
  end if;
  delete from comms.message_index m where m.lane_id = p_lane and m.received_at < pg_catalog.now() - v_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function comms.message_index_purge(text, interval) is
  'Retention (T-061, called by T-042): deletes a lane''s message metadata older than the interval (default and maximum: lane policy retention_days; minimum 1 day). Security invoker: service_role privileges suffice.';
revoke all on function comms.message_index_purge(text, interval) from public, anon, authenticated;
grant execute on function comms.message_index_purge(text, interval) to service_role;

-- Events age by end_at (a cancelled stub without times, by updated_at); kept at most 180 days, at least 30.
create function cal.event_index_purge(p_lane text, p_keep interval default interval '180 days')
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_keep interval;
  v_n integer;
begin
  if p_lane is null or p_keep is null or p_keep < interval '30 days' then
    raise exception 'keep at least 30 days of event metadata' using errcode = '22023';
  end if;
  v_keep := least(p_keep, interval '180 days');
  delete from cal.event_index e
  where e.lane_id = p_lane and coalesce(e.end_at, e.updated_at) < pg_catalog.now() - v_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function cal.event_index_purge(text, interval) is
  'Retention (T-061, called by T-042): deletes a lane''s events that ended before the interval (default and maximum 180 days; minimum 30 days). Security invoker.';
revoke all on function cal.event_index_purge(text, interval) from public, anon, authenticated;
grant execute on function cal.event_index_purge(text, interval) to service_role;
