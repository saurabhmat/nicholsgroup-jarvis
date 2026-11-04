-- T-036: webhook receiver framework. core.webhook_events is the dedupe and receipt log for provider webhooks
-- (QuickBooks, Stripe, Gmail push, monday, ...). One row per delivered event, keyed (lane_id, provider, event_id).
--
-- Lane at receipt: the receiver resolves the lane from SERVER data before it records anything: the provider account id
-- in the (already signature-verified) payload is looked up against core.connections with the D-23 rule
-- (provider + lower(account), status not in disconnected/pending), one enabled lane at a time. The payload never names
-- a lane. So every row has a real lane_id and a connection, and the dedupe key is (lane_id, provider, event_id): two
-- lanes cannot collide, and (D-23) one account belongs to one lane anyway.
--
-- Stored: ids, event type, a SHA-256 of the raw body, status, timestamps. NEVER the payload or any content (rule 6);
-- the job that handles the event fetches the objects through the connector.
--
-- Access: private writes. service_role has NO table grants; it reaches the table only through the four security-definer
-- functions below (each lane-checked). Reads: owner and admin_technical at aal2 through the standard lane policy on the
-- 'health' view (the same audience as core.sync_runs): "was this webhook received, and was it queued". payload_hash and
-- nothing else sensitive is withheld by column grants.
-- Retention: core.webhook_events_purge (default 30 days, never under 7) for the T-042 retention job to call.

create table core.webhook_events (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null
    check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'monday', 'notion', 'timesolv')),
  -- The provider's event id (or an id the provider adapter derived from the event content when the provider sends none).
  event_id text not null check (length(event_id) between 1 and 256 and event_id !~ '[[:cntrl:]]'),
  event_type text not null check (length(event_type) between 1 and 128 and event_type !~ '[[:cntrl:]]'),
  -- SHA-256 (hex) of the raw request body. Lets a repeat of an id with different content be noticed. Not the body.
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- received: recorded, not yet handed to the job queue (or the hand-off is in flight).
  -- enqueued: the Inngest event was accepted. failed: the hand-off failed; the provider's retry claims it again.
  status text not null default 'received' check (status in ('received', 'enqueued', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 1000),
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, provider, event_id),
  -- Lane-consistent: the connection belongs to the same lane (target is unique (id, lane_id)).
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on delete restrict
);
comment on table core.webhook_events is
  'Webhook receipt and dedupe log (T-036): ids, type, hash, status; never payloads. Written only by core.webhook_event_* functions.';
comment on column core.webhook_events.payload_hash is 'SHA-256 of the raw body; never readable through the API.';

create index webhook_events_lane_received_idx on core.webhook_events (lane_id, received_at);
create index webhook_events_connection_idx on core.webhook_events (connection_id);

create trigger webhook_events_set_updated_at before update on core.webhook_events
  for each row execute function core.set_updated_at();

alter table core.webhook_events enable row level security;

create policy webhook_events_select on core.webhook_events
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'health'))::text[])
  );

revoke all on core.webhook_events from public, anon, authenticated, service_role;
grant select (id, lane_id, connection_id, provider, event_id, event_type, status, attempts, received_at, updated_at)
  on core.webhook_events to authenticated;

-- ---------------------------------------------------------------- resolve: provider account -> connection (one lane)
-- The D-23 predicate, identical to the connections_one_lane_per_account index (status not in disconnected/pending,
-- lower()). Asked per lane, so each query carries a lane id; returns null for an unknown account, a disconnected or
-- pending connection and a disabled lane (all look the same to the caller).
create function core.webhook_resolve_connection(p_lane text, p_provider text, p_account text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_lane is null or p_provider is null or p_account is null
     or pg_catalog.length(p_account) not between 1 and 256 then
    return null;
  end if;
  select c.id into v_id
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.lane_id = p_lane
    and c.provider = p_provider
    and pg_catalog.lower(c.external_account_id) = pg_catalog.lower(p_account)
    and c.status not in ('disconnected', 'pending');
  return v_id;
end;
$$;
comment on function core.webhook_resolve_connection(text, text, text) is
  'Webhook receiver (T-036): the usable connection of this lane for a provider account (D-23 predicate); null when none.';
revoke all on function core.webhook_resolve_connection(text, text, text) from public, anon, authenticated;
grant execute on function core.webhook_resolve_connection(text, text, text) to service_role;

-- ---------------------------------------------------------------- claim: dedupe and take the hand-off
-- Returns 'process' when this call should enqueue the event: a new row, a row whose hand-off failed, or a row stuck in
-- 'received' for over two minutes (a crashed receiver). 'duplicate' when the event was already queued or is being
-- queued right now. 'conflict' when it was already queued but with a DIFFERENT body hash (nothing is queued again; the
-- receiver logs it). A retry of an unfinished hand-off is always claimed, whatever its hash (a provider may change
-- delivery metadata between retries, and dropping the event would lose it); the newest hash is kept.
-- One INSERT ... ON CONFLICT DO NOTHING, then one guarded UPDATE: two concurrent deliveries cannot both get 'process'.
create function core.webhook_event_claim(
  p_lane text,
  p_connection_id uuid,
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_payload_hash text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
  v_id uuid;
  v_hash text;
begin
  if p_lane is null or p_connection_id is null or p_provider is null or p_event_id is null
     or p_event_type is null or p_payload_hash is null then
    raise exception 'lane, connection, provider, event id, type and hash are required' using errcode = '22004';
  end if;
  select true into v_ok
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.id = p_connection_id and c.lane_id = p_lane and c.provider = p_provider
    and c.status not in ('disconnected', 'pending');
  if v_ok is null then
    raise exception 'connection not found in this lane' using errcode = '42501';
  end if;

  insert into core.webhook_events (lane_id, connection_id, provider, event_id, event_type, payload_hash)
  values (p_lane, p_connection_id, p_provider, p_event_id, p_event_type, p_payload_hash)
  on conflict (lane_id, provider, event_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return 'process';
  end if;

  update core.webhook_events w
  set status = 'received', payload_hash = p_payload_hash, attempts = least(w.attempts + 1, 1000),
      updated_at = pg_catalog.now()
  where w.lane_id = p_lane and w.provider = p_provider and w.event_id = p_event_id
    and (w.status = 'failed' or (w.status = 'received' and w.updated_at < pg_catalog.now() - interval '2 minutes'))
  returning w.id into v_id;
  if v_id is not null then
    return 'process';
  end if;

  select w.payload_hash into v_hash
  from core.webhook_events w
  where w.lane_id = p_lane and w.provider = p_provider and w.event_id = p_event_id;
  return case when v_hash is distinct from p_payload_hash then 'conflict' else 'duplicate' end;
end;
$$;
comment on function core.webhook_event_claim(text, uuid, text, text, text, text) is
  'Webhook receiver (T-036): records an event once per (lane, provider, event id); returns process | duplicate | conflict.';
revoke all on function core.webhook_event_claim(text, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function core.webhook_event_claim(text, uuid, text, text, text, text) to service_role;

-- ---------------------------------------------------------------- mark: record the hand-off result
-- Only a 'received' row moves, and only to enqueued or failed. Returns whether a row changed.
create function core.webhook_event_mark(p_lane text, p_provider text, p_event_id text, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_status is null or p_status not in ('enqueued', 'failed') then
    raise exception 'status must be enqueued or failed' using errcode = '22023';
  end if;
  update core.webhook_events w
  set status = p_status
  where w.lane_id = p_lane and w.provider = p_provider and w.event_id = p_event_id and w.status = 'received'
  returning w.id into v_id;
  return v_id is not null;
end;
$$;
comment on function core.webhook_event_mark(text, text, text, text) is
  'Webhook receiver (T-036): received -> enqueued | failed, lane-bound; false when nothing changed.';
revoke all on function core.webhook_event_mark(text, text, text, text) from public, anon, authenticated;
grant execute on function core.webhook_event_mark(text, text, text, text) to service_role;

-- ---------------------------------------------------------------- purge (retention)
-- Deletes one lane's receipts older than p_keep. The floor is 7 days: providers retry for days (Stripe up to 3), and a
-- row is what stops a late retry being handled twice. T-042's retention job calls this per lane.
create function core.webhook_events_purge(p_lane text, p_keep interval default interval '30 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null or p_keep is null or p_keep < interval '7 days' then
    raise exception 'keep at least 7 days of webhook receipts' using errcode = '22023';
  end if;
  delete from core.webhook_events w where w.lane_id = p_lane and w.received_at < pg_catalog.now() - p_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
comment on function core.webhook_events_purge(text, interval) is
  'Retention (T-036, called by T-042): deletes a lane''s webhook receipts older than the interval (minimum 7 days).';
revoke all on function core.webhook_events_purge(text, interval) from public, anon, authenticated;
grant execute on function core.webhook_events_purge(text, interval) to service_role;
