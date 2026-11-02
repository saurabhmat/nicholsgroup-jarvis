-- T-039: raw source records (architecture §6: raw.source_records -> normalized tables). The latest provider payload for
-- each object a connector syncs, keyed by (connection, object type, external id). Normalizers (fin.*, later tasks) read it.
--
-- Private table, like core.connection_secrets: RLS on, no policy, no grants to API roles or service_role. Raw payloads
-- are finance data and (for lanes that allow it) message/document content, so no signed-in user and no job reads them
-- directly; code reaches them only through reviewed security-definer functions. This one writes:
--   core.source_records_upsert(lane, connection, records): service_role only; the connection must belong to the lane
--   and the provider is taken from the connection row, never from the caller.
-- Content guard (rule 6): for comms/docs providers a payload that carries a body field is refused unless the lane policy
-- store_content_bodies is true. Enforced by a trigger on the table (so no write path skips it) and again in TypeScript.
-- The schema `raw` is not in the API's exposed schemas (config.toml): nothing here is reachable through PostgREST.

create schema raw;
revoke all on schema raw from public, anon, authenticated, service_role;

-- Providers whose payloads can hold message or document content. Keep in step with CONTENT_PROVIDERS in
-- packages/connectors/src/raw/guard.ts (a pgTAP test and a Vitest test pin both lists).
create function raw.is_content_provider(p_provider text) returns boolean
language sql immutable set search_path = ''
as $$ select p_provider in ('google', 'microsoft', 'notion') $$;

-- Whether the payload has a key that names body/content, at any depth (keys compared lower-case without punctuation, so
-- `body_preview`, `bodyPreview` and `Body-Preview` are one name). Fails closed: nesting deeper than 16 levels counts.
-- Keep the list in step with BODY_FIELD_NAMES in guard.ts.
create function raw.payload_has_body_field(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  with recursive walk (v, depth) as (
    select p_payload, 0
    union all
    select c.value, w.depth + 1
    from walk w
    cross join lateral (
      select e.value from pg_catalog.jsonb_each(w.v) e where pg_catalog.jsonb_typeof(w.v) = 'object'
      union all
      select a.value from pg_catalog.jsonb_array_elements(w.v) a where pg_catalog.jsonb_typeof(w.v) = 'array'
    ) c
    where w.depth < 16
  )
  select exists (select 1 from walk where depth >= 16)
      or exists (
        select 1 from walk w
        cross join lateral pg_catalog.jsonb_object_keys(w.v) k
        where pg_catalog.jsonb_typeof(w.v) = 'object'
          and pg_catalog.lower(pg_catalog.regexp_replace(k, '[^A-Za-z0-9]', '', 'g')) in (
            'body', 'bodypreview', 'bodyhtml', 'htmlbody', 'textbody', 'plainbody', 'uniquebody', 'snippet', 'html',
            'htmlcontent', 'content', 'contenthtml', 'text', 'textcontent', 'plaintext', 'richtext', 'markdown', 'raw')
      );
$$;

revoke all on function raw.is_content_provider(text) from public, anon, authenticated;
revoke all on function raw.payload_has_body_field(jsonb) from public, anon, authenticated;

create table raw.source_records (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  connection_id uuid not null,
  provider text not null
    check (provider in ('quickbooks', 'stripe', 'gohighlevel', 'google', 'microsoft', 'monday', 'notion', 'timesolv')),
  object_type text not null check (object_type ~ '^[A-Za-z][A-Za-z0-9_.]{0,63}$'),
  external_id text not null check (length(external_id) between 1 and 256),
  payload jsonb not null check (pg_catalog.jsonb_typeof(payload) = 'object' and pg_catalog.octet_length(payload::text) <= 1048576),
  -- SHA-256 (hex) of the payload's jsonb text form; set by the trigger, so a caller cannot supply a wrong one.
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- Provider's last-updated time for the object, when it has one.
  source_updated_at timestamptz,
  -- CDC/delta deletion marker; the row stays until retention purges it.
  deleted boolean not null default false,
  -- When the connector last saw this object.
  synced_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- A record belongs to a connection in the same lane (a lane cannot file records under another lane's connection).
  foreign key (connection_id, lane_id) references core.connections (id, lane_id) on update restrict on delete restrict,
  unique (connection_id, object_type, external_id)
);
comment on table raw.source_records is
  'Latest provider payload per synced object (T-039). Private: written by core.source_records_upsert only; no direct grants.';
create index source_records_lane_id_idx on raw.source_records (lane_id);
create index source_records_lane_type_idx on raw.source_records (lane_id, provider, object_type);

alter table raw.source_records enable row level security;
revoke all on raw.source_records from public, anon, authenticated, service_role;

-- Sets the hash and applies the content guard on every insert/update, whoever writes.
create function raw.source_records_before_write() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.payload_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.payload::text, 'UTF8')), 'hex');
  if raw.is_content_provider(new.provider)
     and raw.payload_has_body_field(new.payload)
     and not coalesce((select p.store_content_bodies from core.lane_policies p where p.lane_id = new.lane_id), false) then
    raise exception 'raw.source_records: lane % does not store content bodies', new.lane_id using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function raw.source_records_before_write() from public, anon, authenticated;
create trigger source_records_before_write before insert or update on raw.source_records
  for each row execute function raw.source_records_before_write();

-- Batch upsert for one connection. Each element: {object_type, external_id, payload, source_updated_at, deleted,
-- synced_at}. Returns the number of rows written. A bad lane/connection pair is the same error whether the connection
-- is missing or another lane's (no probing).
create function core.source_records_upsert(p_lane text, p_connection_id uuid, p_records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_count integer;
begin
  if p_lane is null or p_connection_id is null or p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array' then
    raise exception 'lane, connection and a records array are required' using errcode = '22004';
  end if;
  if pg_catalog.jsonb_array_length(p_records) > 1000 then
    raise exception 'too many records in one batch' using errcode = '54000';
  end if;
  select c.provider into v_provider from core.connections c where c.id = p_connection_id and c.lane_id = p_lane;
  if v_provider is null then
    raise exception 'connection not found in this lane' using errcode = '42501';
  end if;
  insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash,
                                  source_updated_at, deleted, synced_at)
  select distinct on (r.object_type, r.external_id)
         p_lane, p_connection_id, v_provider, r.object_type, r.external_id, r.payload, '', r.source_updated_at,
         coalesce(r.deleted, false), r.synced_at
  from rows from (pg_catalog.jsonb_to_recordset(p_records) as (object_type text, external_id text, payload jsonb,
                                                      source_updated_at timestamptz, deleted boolean, synced_at timestamptz))
       with ordinality as r (object_type, external_id, payload, source_updated_at, deleted, synced_at, n)
  -- Within one batch the last element for an object wins.
  order by r.object_type, r.external_id, r.n desc
  on conflict (connection_id, object_type, external_id) do update
    set payload = excluded.payload, source_updated_at = excluded.source_updated_at, deleted = excluded.deleted,
        synced_at = excluded.synced_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
comment on function core.source_records_upsert(text, uuid, jsonb) is
  'Upserts raw source records for one connection (T-039); service_role only; provider comes from the connection row.';
revoke all on function core.source_records_upsert(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function core.source_records_upsert(text, uuid, jsonb) to service_role;
