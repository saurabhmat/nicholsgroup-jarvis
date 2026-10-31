-- T-014: append-only audit log (architecture §6 M1, §7: approvals and audit are immutable, kept 7 years).
-- Rows are written only through audit.log() (service_role, or security-definer functions owned by postgres that
-- call it), so a signed-in user cannot write or forge entries. No role may update, delete or truncate: grants are
-- withheld from everyone and a trigger refuses the operation even for the table owner.
-- Read: AAL2 members with the 'audit' view (owner).

create schema if not exists audit;
revoke all on schema audit from public, anon;
grant usage on schema audit to authenticated, service_role;

create table audit.events (
  id bigint generated always as identity primary key,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  actor_kind text not null check (actor_kind in ('user', 'service', 'system')),
  -- The acting user for actor_kind = 'user' (no FK: the entry must outlive the user); null otherwise.
  actor_id uuid,
  -- Dotted event name, e.g. 'lane_config.version_created', 'approval.approved'.
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(action) <= 100),
  -- What the action was about, as an id or reference (never content), e.g. 'lane_config:PKG:3'.
  -- A reference shape only; the secret check catches key-like references (e.g. 'sk_live_...').
  target text check (target ~ '^[A-Za-z0-9_.:/@-]+$' and length(target) <= 300 and not core.jsonb_has_secret(pg_catalog.jsonb_build_object('target', target))),
  -- Small structured context. Redacted by the caller (T-015); the database refuses credential-like keys and values.
  metadata jsonb not null default '{}'
    check (pg_catalog.jsonb_typeof(metadata) = 'object')
    check (pg_catalog.pg_column_size(metadata) < 16384)
    check (not core.jsonb_has_secret(metadata)),
  at timestamptz not null default now(),
  check ((actor_kind = 'user') = (actor_id is not null))
);
comment on table audit.events is 'Append-only audit log (T-014). Insert through audit.log() only; no update or delete for any role.';
create index events_lane_at_idx on audit.events (lane_id, at desc);

create function audit.events_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit.events is append-only' using errcode = '42501';
end;
$$;
revoke all on function audit.events_immutable() from public, anon, authenticated;

create trigger events_no_update_delete before update or delete on audit.events
  for each row execute function audit.events_immutable();
create trigger events_no_truncate before truncate on audit.events
  for each statement execute function audit.events_immutable();

-- The only write path. Returns the new event id. Callable by service_role (server code that has verified the session
-- and passes the actor) and by security-definer functions owned by postgres.
create function audit.log(
  p_lane_id text,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_target text default null,
  p_metadata jsonb default '{}'
) returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into audit.events (lane_id, actor_kind, actor_id, action, target, metadata)
  values (p_lane_id, p_actor_kind, p_actor_id, p_action, p_target, coalesce(p_metadata, '{}'::jsonb))
  returning id;
$$;
revoke all on function audit.log(text, text, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function audit.log(text, text, uuid, text, text, jsonb) to service_role;

alter table audit.events enable row level security;

create policy events_select on audit.events
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'audit'))::text[])
  );

-- No insert, update, delete or truncate for anyone except through audit.log() (definer, owner postgres).
revoke all on audit.events from public, anon, authenticated, service_role;
grant select on audit.events to authenticated, service_role;
