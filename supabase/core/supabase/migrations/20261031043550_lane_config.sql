-- T-011: per-lane source settings, versioned and insert-only. The shape is validated by the shared Zod schema
-- (@nichols/core/lane-config) before every write; the database independently refuses anything that looks like a
-- credential (keys or values), because config is not a place for secrets (env and the Vault are).
-- Read: AAL2 members with the 'config' view (owner, admin_technical). Write: service_role only, insert only.

-- True when any key in `p_config` (at any depth) is credential-named, or any string value looks like a secret:
-- vendor key prefixes (mirrors packages/core/src/env/secret-patterns.js), PEM private keys, JWTs, URLs with a password.
create function core.jsonb_has_secret(p_config jsonb) returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive walk (key, value) as (
    select null::text, p_config
    union all
    select e.key, e.value
    from walk w
    cross join lateral (
      select o.key, o.value from pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(w.value) = 'object' then w.value end) o
      union all
      select null::text, a.value from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(w.value) = 'array' then w.value end) a
    ) e
  )
  select exists (
    select 1 from walk
    where key ~* '(secret|token|passw|pwd|private|credential|api_?key|bearer|signing|cookie|session)'
       or (pg_catalog.jsonb_typeof(value) = 'string' and pg_catalog.btrim(value #>> '{}') ~ (
            '^(sb_secret_|sk_|rk_|whsec_|sk-ant-|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|signkey-|GOCSPX-|re_[A-Za-z0-9]|sntry[a-z]_|ntn_|secret_|pit-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)'
            || '|-----BEGIN [A-Z ]*PRIVATE KEY-----'
            || '|^[a-z][a-z0-9+.-]*://[^/@[:space:]]*:[^/@[:space:]]+@'))
  );
$$;
revoke all on function core.jsonb_has_secret(jsonb) from public, anon;
grant execute on function core.jsonb_has_secret(jsonb) to authenticated, service_role;

create table core.lane_config (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  version integer not null check (version >= 1),
  config jsonb not null check (pg_catalog.jsonb_typeof(config) = 'object') check (not core.jsonb_has_secret(config)),
  created_at timestamptz not null default now(),
  created_by uuid references core.users (id) on delete set null,
  primary key (lane_id, version)
);
comment on table core.lane_config is
  'Per-lane settings (T-011), insert-only versions; the current config is the highest version. No secrets.';

-- Versions are append-only and gapless: a new row must be exactly the next version for its lane.
create function core.lane_config_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'core.lane_config is insert-only' using errcode = '42501';
  end if;
  -- Serialise version allocation per lane.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('core.lane_config:' || new.lane_id));
  if new.version <> coalesce((select max(c.version) from core.lane_config c where c.lane_id = new.lane_id), 0) + 1 then
    raise exception 'core.lane_config: version must be the next version for the lane' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function core.lane_config_guard() from public, anon, authenticated;

create trigger lane_config_guard before insert or update or delete on core.lane_config
  for each row execute function core.lane_config_guard();
create trigger lane_config_no_truncate before truncate on core.lane_config
  for each statement execute function core.lane_config_guard();

-- The current version per lane.
create view core.lane_config_current with (security_invoker = true) as
  select distinct on (lane_id) lane_id, version, config, created_at, created_by
  from core.lane_config
  order by lane_id, version desc;

alter table core.lane_config enable row level security;

create policy lane_config_select on core.lane_config
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'config'))::text[])
  );

revoke all on core.lane_config, core.lane_config_current from public, anon, authenticated;
grant select on core.lane_config, core.lane_config_current to authenticated;
grant select, insert on core.lane_config to service_role;
grant select on core.lane_config_current to service_role;
