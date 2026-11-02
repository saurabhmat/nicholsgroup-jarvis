-- T-039: raw source records (architecture §6: raw.source_records -> normalized tables). The latest provider payload for
-- each object a connector syncs, keyed by (connection, object type, external id). Normalizers (fin.*, later tasks) read it.
--
-- Private table, like core.connection_secrets: RLS on, no policy, no grants to API roles or service_role. Raw payloads
-- are finance data and (for lanes that allow it) message/document content, so no signed-in user and no job reads them
-- directly; code reaches them only through reviewed security-definer functions. This one writes:
--   core.source_records_upsert(lane, connection, records): service_role only; the connection must belong to the lane
--   and the provider is taken from the connection row, never from the caller.
-- Forbidden-data guard (every provider): payloads with SSN / bank / rate / credential keys are refused (trigger, authoritative).
-- Both guards are DENYLISTS and only a backstop: each adapter must project to a strict per-provider/object_type allowlist.
-- Content guard (rule 6): for content providers a payload that carries a body field is refused unless the lane policy
-- store_content_bodies is true. Enforced by a trigger on the table (so no write path skips it) and again in TypeScript.
-- The schema `raw` is not in the API's exposed schemas (config.toml): nothing here is reachable through PostgREST.

create schema raw;
revoke all on schema raw from public, anon, authenticated, service_role;

-- Providers whose payloads can hold message, document, task or time-entry narrative content. Keep in step with
-- CONTENT_PROVIDERS in packages/connectors/src/raw/guard.ts (pgTAP and Vitest tests pin every list below).
create function raw.is_content_provider(p_provider text) returns boolean
language sql immutable set search_path = ''
as $$ select p_provider in ('google', 'microsoft', 'notion', 'monday', 'gohighlevel', 'timesolv') $$;

-- Key matching. A key is normalised (NFKD compatibility fold, which also strips accents and folds full-width forms;
-- lower-case; everything but a-z0-9 removed) so `body_preview`, `Body-Preview` and `ｂｏｄｙ` are one name.
-- Cross-script look-alikes (Cyrillic o in "body") are not folded: adapters must project to metadata anyway.
create function raw.normalize_key(p_key text) returns text
language sql immutable set search_path = ''
as $$ select pg_catalog.regexp_replace(pg_catalog.lower(normalize(p_key, NFKD)), '[^a-z0-9]', '', 'g') $$;

-- Content-body key lists (keep in step with guard.ts). A normalised key is a body field when it equals an exact name,
-- or, after removing the safe tokens (metadata names that merely contain a content word), contains a substring.
create function raw.body_exact_names() returns text[]
language sql immutable set search_path = ''
as $$ select array['raw'] $$;
create function raw.body_substrings() returns text[]
language sql immutable set search_path = ''
as $$ select array['body', 'content', 'text', 'description', 'notes', 'snippet', 'html', 'markdown', 'message',
                   'comment', 'attachment', 'bytes', 'values', 'dataurl', 'narrative', 'note', 'memo', 'transcript',
                   'preview', 'excerpt', 'caption'] $$;
-- Safe tokens, longest first (no token is a prefix of a later one, so leftmost-first and leftmost-longest regex engines
-- agree). Documented: content type/length/id/encoding/language/disposition/md5, "context", text colour, message/comment/
-- attachment ids and counts, link fields (htmlLink, webContentLink) and mailbox counters stay storable.
create function raw.body_safe_tokens() returns text[]
language sql immutable set search_path = ''
as $$ select array['contentdisposition', 'contentlanguage', 'contentencoding', 'attachmentcount', 'lastmessagetype',
                   'lastmessagedate', 'hasattachments', 'webcontentlink', 'messagesunread', 'messagestotal',
                   'contentlength', 'contenttype', 'attachmentid', 'hasattachment', 'messagecount', 'commentcount',
                   'textcolor', 'messageids', 'messageid', 'commentid', 'contentmd5', 'contentid', 'htmllink',
                   'context'] $$;

-- Forbidden-data rules (PII, bank identifiers, rates, credentials), applied to every provider. A key is split into words
-- (camelCase, digits, `_`, `-`, `.` and other punctuation are boundaries; see raw.key_words) and also kept in joined,
-- normalised form. Refused when:
--   * a word, or the joined key, equals one of forbidden_words, with or without a trailing plural s (whole words only:
--     classname and pinned pass; S.S.N., s_sn, sSN, ssns and SSNs are refused);
--   * the joined form contains one of forbidden_contained;
--   * the words, joined by spaces, end in one of forbidden_word_ends (clientSecret yes, secretary no);
--   * a word ends in `token`/`tokens`, unless the joined key is one of token_safe_names (SyncToken, nextPageToken, ...);
--   * the word `rate`/`rates` sits next to one of rate_neighbours (hourlyRate, rate_bill), or, for timesolv, appears at all.
create function raw.forbidden_words() returns text[]
language sql immutable set search_path = ''
as $$ select array['ssn', 'sin', 'ein', 'tin', 'pin', 'iban', 'swift', 'bic'] $$;
create function raw.forbidden_contained() returns text[]
language sql immutable set search_path = ''
as $$ select array['socialsecurity', 'taxid', 'acctnum', 'accountnum', 'acctno', 'routing', 'salary', 'wage',
                   'compensation', 'payroll', 'password', 'passwd', 'apikey', 'privatekey', 'credential',
                   'billrate', 'costrate', 'payrate', 'hourlyrate', 'billingrate', 'fein', 'itin', 'authorization',
                   'cookie', 'passcode', 'pwd'] $$;
-- Forbidden at the end of a word (optional plural s), tested on the words joined by single spaces: clientsecret,
-- webhook_secret, accountNo, account_no match; secretary and accountNotes do not.
create function raw.forbidden_word_ends() returns text[]
language sql immutable set search_path = ''
as $$ select array['secret', 'secretkey', 'accountno', 'account no'] $$;
create function raw.token_safe_names() returns text[]
language sql immutable set search_path = ''
as $$ select array['synctoken', 'pagetoken', 'nextpagetoken', 'deltatoken', 'nextsynctoken', 'startpagetoken'] $$;
create function raw.rate_neighbours() returns text[]
language sql immutable set search_path = ''
as $$ select array['bill', 'cost', 'pay', 'hourly'] $$;

-- Words of a key: NFKD fold, combining marks dropped, boundaries at camelCase / acronym ends / letter-digit changes,
-- lower-cased, anything but a-z0-9 is a separator. `employeeSsn` -> {employee,ssn}; `SSNLast4` -> {ssn,last,4}.
create function raw.key_words(p_key text) returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.string_to_array(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(
    pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(pg_catalog.regexp_replace(normalize(p_key, NFKD), '[̀-ͯ]', '', 'g'),
                                '[\u200B-\u200D\u2060\uFEFF\u00AD]', '', 'g'),
      '([a-z0-9])([A-Z])', '\1 \2', 'g'),
      '([A-Z])(?=[A-Z](?:[a-rt-z]|s[a-z]))', '\1 ', 'g'),
      '([A-Za-z])([0-9])', '\1 \2', 'g'),
      '([0-9])([A-Za-z])', '\1 \2', 'g')),
    '[^a-z0-9]+', ' ', 'g'), ' '), ' '), '{}'::text[])
$$;

-- Every key at any depth (raw, not normalised) as (k, is_deep) rows. When anything sits 16 or more levels down one extra
-- row (null, true) is emitted (fails closed); a key can never be confused with it, whatever it is named. Callers normalise.
create function raw.payload_key_names(p_payload jsonb) returns table (k text, is_deep boolean)
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
  select null::text, true where exists (select 1 from walk where depth >= 16)
  union all
  select jk, false from walk w cross join lateral pg_catalog.jsonb_object_keys(w.v) jk where pg_catalog.jsonb_typeof(w.v) = 'object';
$$;

-- One walk, one normalisation per distinct key, for both guards. Returns whether any key trips the forbidden-data rules
-- and (when p_want_body) the content-body rules. Distinct keys are capped at 20000 and one key at 256 characters (fails
-- closed, 22023, before any key is normalised); anything 16 or more levels down trips both. The body test removes the safe tokens once and then runs a single combined regex.
create function raw.payload_scan(p_payload jsonb, p_provider text, p_want_body boolean,
                                 out has_forbidden boolean, out has_body boolean)
language plpgsql immutable set search_path = ''
as $$
declare
  v_keys text[];
  v_deep boolean;
  v_k text;
  v_nk text;
  v_words text[];
  v_safe_re text := pg_catalog.array_to_string(raw.body_safe_tokens(), '|');
  v_body_re text := pg_catalog.array_to_string(raw.body_substrings(), '|');
  v_forb_re text := pg_catalog.array_to_string(raw.forbidden_contained(), '|');
  v_exact text[] := raw.body_exact_names();
  v_fwords text[] := raw.forbidden_words();
  v_tsafe text[] := raw.token_safe_names();
  v_ends_re text := '(?:' || pg_catalog.array_to_string(raw.forbidden_word_ends(), '|') || ')s?(?: |$)';
  v_neigh text[] := raw.rate_neighbours();
begin
  has_forbidden := false;
  has_body := false;
  select pg_catalog.array_agg(d.k) filter (where not d.is_deep), coalesce(pg_catalog.bool_or(d.is_deep), false)
  into v_keys, v_deep
  from (select distinct n.k, n.is_deep from raw.payload_key_names(p_payload) n limit 20002) d;
  if pg_catalog.cardinality(v_keys) > 20000 then
    raise exception 'raw.source_records: payload has too many distinct keys' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.unnest(v_keys) x where pg_catalog.char_length(x) > 256) then
    raise exception 'raw.source_records: payload has a key that is too long' using errcode = '22023';
  end if;
  if v_deep then
    has_forbidden := true;
    has_body := p_want_body;
  end if;
  foreach v_k in array coalesce(v_keys, '{}'::text[]) loop
    exit when has_forbidden and (has_body or not p_want_body);
    v_nk := raw.normalize_key(v_k);
    if not has_forbidden then
      v_words := raw.key_words(v_k);
      has_forbidden := coalesce(
        v_words && v_fwords
        or exists (select 1 from pg_catalog.unnest(v_words) w
                   where pg_catalog.length(w) > 3 and w ~ 's$' and pg_catalog.left(w, -1) = any (v_fwords))
        or v_nk = any (v_fwords)
        or (pg_catalog.length(v_nk) > 3 and v_nk ~ 's$' and pg_catalog.left(v_nk, -1) = any (v_fwords))
        or v_nk ~ v_forb_re
        or pg_catalog.array_to_string(v_words, ' ') ~ v_ends_re
        or (v_nk <> all (v_tsafe) and exists (select 1 from pg_catalog.unnest(v_words) w where w ~ 'tokens?$'))
        or (v_words && array['rate', 'rates']
            and (p_provider = 'timesolv'
                 or exists (select 1 from pg_catalog.generate_subscripts(v_words, 1) i
                            where v_words[i] in ('rate', 'rates') and (v_words[i - 1] = any (v_neigh) or v_words[i + 1] = any (v_neigh))))),
        false);
    end if;
    if p_want_body and not has_body then
      has_body := v_nk = any (v_exact) or pg_catalog.regexp_replace(v_nk, v_safe_re, '', 'g') ~ v_body_re;
    end if;
  end loop;
end;
$$;

create function raw.payload_has_body_field(p_payload jsonb) returns boolean
language sql immutable set search_path = ''
as $$ select (raw.payload_scan(p_payload, null, true)).has_body $$;

create function raw.payload_has_forbidden_field(p_payload jsonb, p_provider text default null) returns boolean
language sql immutable set search_path = ''
as $$ select (raw.payload_scan(p_payload, p_provider, false)).has_forbidden $$;

revoke all on function raw.is_content_provider(text) from public, anon, authenticated;
revoke all on function raw.normalize_key(text) from public, anon, authenticated;
revoke all on function raw.body_exact_names() from public, anon, authenticated;
revoke all on function raw.body_substrings() from public, anon, authenticated;
revoke all on function raw.body_safe_tokens() from public, anon, authenticated;
revoke all on function raw.forbidden_words() from public, anon, authenticated;
revoke all on function raw.forbidden_contained() from public, anon, authenticated;
revoke all on function raw.forbidden_word_ends() from public, anon, authenticated;
revoke all on function raw.token_safe_names() from public, anon, authenticated;
revoke all on function raw.rate_neighbours() from public, anon, authenticated;
revoke all on function raw.key_words(text) from public, anon, authenticated;
revoke all on function raw.payload_scan(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function raw.payload_key_names(jsonb) from public, anon, authenticated;
revoke all on function raw.payload_has_body_field(jsonb) from public, anon, authenticated;
revoke all on function raw.payload_has_forbidden_field(jsonb, text) from public, anon, authenticated;

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

-- Sets the hash and applies the forbidden-data and content guards on every insert/update, whoever writes.
-- One scan serves both guards. Cost note: an upsert that hits ON CONFLICT DO UPDATE runs the guards on the proposed row
-- (BEFORE INSERT) and, when the payload changed, again on the updated row (BEFORE UPDATE); the second run is skipped when
-- the payload, provider and lane are unchanged (the stored payload was guarded when it was written; an unchanged payload
-- stores no new content even if the lane policy has since tightened). Each scan is bounded by the 1 MB payload limit
-- and the 20000 distinct-key cap.
create function raw.source_records_before_write() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_scan record;
  v_content boolean;
begin
  new.payload_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new.payload::text, 'UTF8')), 'hex');
  if tg_op = 'UPDATE' and new.payload is not distinct from old.payload
     and new.provider = old.provider and new.lane_id = old.lane_id then
    return new;
  end if;
  v_content := raw.is_content_provider(new.provider);
  v_scan := raw.payload_scan(new.payload, new.provider, v_content);
  -- Forbidden data (any provider): refused with no detail, the payload is never echoed.
  if v_scan.has_forbidden then
    raise exception 'raw.source_records: payload contains a field that must not be stored' using errcode = '22023';
  end if;
  if v_content and v_scan.has_body
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
-- synced_at}. Returns the number of rows written (rows skipped as stale or superseded in the batch are not counted). A bad lane/connection pair,
-- a connection that is not active/degraded, or a disabled lane is the same 42501 error as a missing connection (no
-- probing). Every element is validated here before any insert, with our own messages and no DETAIL, so a payload never
-- reaches the Postgres log through a constraint error. Limits: 1000 records and 8 MB per call here (the TypeScript
-- store sends at most 500 records and ~5 MB per call, so it stays under); 1 MB per payload.
create function core.source_records_upsert(p_lane text, p_connection_id uuid, p_records jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_count integer;
  v_e jsonb;
  v_n integer := 0;
  v_ts_re constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$';
begin
  if p_lane is null or p_connection_id is null or p_records is null or pg_catalog.jsonb_typeof(p_records) <> 'array' then
    raise exception 'lane, connection and a records array are required' using errcode = '22004';
  end if;
  if pg_catalog.jsonb_array_length(p_records) > 1000 or pg_catalog.octet_length(p_records::text) > 8388608 then
    raise exception 'too many records in one batch' using errcode = '54000';
  end if;
  select c.provider into v_provider
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.id = p_connection_id and c.lane_id = p_lane and c.status in ('active', 'degraded');
  if v_provider is null then
    raise exception 'connection not found in this lane' using errcode = '42501';
  end if;

  for v_e in select e from pg_catalog.jsonb_array_elements(p_records) e loop
    v_n := v_n + 1;
    if pg_catalog.jsonb_typeof(v_e) <> 'object' then
      raise exception 'record % is not an object', v_n using errcode = '22023';
    end if;
    -- Size first: nothing else about an oversized payload is evaluated.
    if pg_catalog.jsonb_typeof(v_e -> 'payload') is distinct from 'object' then
      raise exception 'record %: payload must be an object', v_n using errcode = '22023';
    end if;
    if pg_catalog.octet_length((v_e -> 'payload')::text) > 1048576 then
      raise exception 'record %: payload is over 1 MB', v_n using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_e -> 'object_type') is distinct from 'string'
       or (v_e ->> 'object_type') !~ '^[A-Za-z][A-Za-z0-9_.]{0,63}$' then
      raise exception 'record %: object_type is invalid', v_n using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_e -> 'external_id') is distinct from 'string'
       or pg_catalog.length(v_e ->> 'external_id') not between 1 and 256 then
      raise exception 'record %: external_id is invalid', v_n using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(v_e -> 'synced_at') is distinct from 'string' then
      raise exception 'record %: synced_at is required', v_n using errcode = '22023';
    end if;
    -- Timestamps: ISO-8601 with an explicit offset and finite ('infinity', 'now', 'epoch' and the like are refused).
    begin
      if (v_e ->> 'synced_at') !~ v_ts_re or not pg_catalog.isfinite((v_e ->> 'synced_at')::timestamptz) then
        raise exception 'bad time' using errcode = '22007';
      end if;
      if pg_catalog.jsonb_typeof(v_e -> 'source_updated_at') = 'string' then
        if (v_e ->> 'source_updated_at') !~ v_ts_re or not pg_catalog.isfinite((v_e ->> 'source_updated_at')::timestamptz) then
          raise exception 'bad time' using errcode = '22007';
        end if;
      elsif pg_catalog.jsonb_typeof(v_e -> 'source_updated_at') not in ('null') and v_e ? 'source_updated_at' then
        raise exception 'bad time' using errcode = '22007';
      end if;
    exception when others then
      raise exception 'record %: a timestamp is invalid', v_n using errcode = '22023';
    end;
    if v_e ? 'deleted' and pg_catalog.jsonb_typeof(v_e -> 'deleted') not in ('boolean', 'null') then
      raise exception 'record %: deleted must be a boolean', v_n using errcode = '22023';
    end if;
  end loop;

  insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash,
                                  source_updated_at, deleted, synced_at)
  select distinct on (r.object_type, r.external_id)
         p_lane, p_connection_id, v_provider, r.object_type, r.external_id, r.payload, '', r.source_updated_at,
         coalesce(r.deleted, false), r.synced_at
  from rows from (pg_catalog.jsonb_to_recordset(p_records) as (object_type text, external_id text, payload jsonb,
                                                      source_updated_at timestamptz, deleted boolean, synced_at timestamptz))
       with ordinality as r (object_type, external_id, payload, source_updated_at, deleted, synced_at, n)
  -- Within one batch the newest provider version of an object wins (undated versions rank last); among equal ones the
  -- later element.
  order by r.object_type, r.external_id, r.source_updated_at desc nulls last, r.n desc
  on conflict (connection_id, object_type, external_id) do update
    set payload = excluded.payload,
        -- An undated deletion keeps the stored provider time, so a late older update is still skipped afterwards.
        source_updated_at = coalesce(excluded.source_updated_at, raw.source_records.source_updated_at),
        deleted = excluded.deleted, synced_at = excluded.synced_at
    -- An older provider version never overwrites a newer one (late or replayed batches). A record with no
    -- source_updated_at never overwrites one that has it (it is skipped like a stale one), except a deletion: a delete
    -- (Graph @removed, Stripe deleted) must win unless the stored version is strictly newer than a dated one.
    where raw.source_records.source_updated_at is null
       or excluded.source_updated_at >= raw.source_records.source_updated_at
       or (excluded.deleted and excluded.source_updated_at is null);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
comment on function core.source_records_upsert(text, uuid, jsonb) is
  'Upserts raw source records for one connection (T-039); service_role only; provider comes from the connection row.';
revoke all on function core.source_records_upsert(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function core.source_records_upsert(text, uuid, jsonb) to service_role;
