-- T-210: the AI brain (docs/specs/brain-and-employees.md §3, §7a). Schema `brain`: owner-authored documents (with a
-- version history), employee profiles, skills, and the short-lived import candidates. Owner-authored text only: this is
-- not email/chat/document content from a provider (rule 6). `brain` is NOT a PostgREST-exposed schema; the app reaches it
-- through the thin SECURITY INVOKER wrappers `core.brain_*` (core is exposed), exactly as Inbox does (T-202).
--
-- Access
--   * 'brain' joins core.view_names(), so owners get it through core.role_views('owner'); it is not added to the viewer,
--     finance_operator or admin_technical lists (admin_technical has no content views).
--   * Reads: RLS, AAL2 + the lane in core.allowed_lanes(uid, 'brain'). Custom policies (catalog custom_policy_ok):
--       documents / document_versions: About-Me and Preferences are readable by their author only;
--       imports / import_candidates: own rows only, and candidates are unreadable after 24 h.
--     employees and skills use the standard expression.
--   * Writes: NO user DML. Every write is one of the reviewed security-definer functions below. Each checks AAL2, the
--     owner role in the lane (core.has_lane_role), ownership (rows are addressed by auth.uid(), never by a caller-supplied
--     owner), size limits and the secret scan. service_role has no DML either (jobs never write brain rows; no connector
--     path touches brain.*).
--   * The secret scan runs in the functions AND as a CHECK constraint, so a direct insert cannot bypass it.
--
-- Retention (T-042, spec §3 and plan-review finding 19): "last 20 versions" is pruned inside brain.document_save, in the
-- same transaction as the save. Import candidates are not a T-042 day class: core.brain_import_purge(lane), called hourly
-- by the brain.import_purge job, deletes candidates older than 23 h (so none lives past 24 h) and closes stale imports; the
-- read policy hides candidates older than 24 h even if the job is down.

create schema brain;
revoke all on schema brain from public, anon;
grant usage on schema brain to authenticated, service_role;
-- New functions are not executable by PUBLIC unless granted (as in comms/fin).
alter default privileges in schema brain revoke execute on functions from public;

-- ---------------------------------------------------------------- the 'brain' view (owner only)
create or replace function core.view_names() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'lanes', 'lane_policies', 'memberships', 'action_index',                  -- registry and administration
    'finance', 'approvals', 'assistant', 'briefing', 'comms', 'calendar',     -- content
    'documents', 'projects', 'commitments', 'memory', 'brain',
    'connections', 'health', 'jobs', 'config', 'audit'                        -- operations (no content)
  ]::text[];
$$;
revoke all on function core.view_names() from public, anon;
grant execute on function core.view_names() to authenticated, service_role;

-- ---------------------------------------------------------------- pure helpers (not callable by API roles)

-- Brain-style path: 1 to 6 segments of [A-Za-z0-9_-], last one ends in .md, under Context/, Projects/ or Notes/.
create function brain.valid_path(p_path text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_path is not null
     and pg_catalog.length(p_path) <= 200
     and p_path ~ '^(Context|Projects|Notes)(/[A-Za-z0-9_-]+){1,5}\.md$'
     and p_path !~ '/\.md$';
$$;

-- The document kind follows from the path, never from the caller (so a note cannot claim to be About-Me, or the reverse).
create function brain.document_kind(p_path text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_path = 'Context/About-Me.md' then 'about_me'
    when p_path = 'Context/Preferences.md' then 'preferences'
    when p_path ~ '^Context/' then 'context'
    when p_path ~ '^Projects/[A-Za-z0-9_-]+/BRIEF\.md$' then 'project_brief'
    when p_path ~ '^Projects/[A-Za-z0-9_-]+/HANDOFF\.md$' then 'project_handoff'
    else 'note'
  end;
$$;

-- True when free text carries something that looks like a credential. Mirrors looksLikeSecretValue (packages/core/src/
-- secrets) through core.jsonb_has_secret over: the whole text, each line (so "Bearer ..." at a line start is seen), each
-- token of 8+ characters (split on anything outside the token alphabet), plus a Bearer/Basic credential anywhere in a line.
-- Known false positive, accepted (same as lane config): a word that starts with a vendor prefix such as `re_engaged`.
-- Tokens are split twice: once keeping `:=?&#@%` (so a URL or user:pass@host stays whole), once breaking on them and on
-- quotes (so `STRIPE_SECRET_KEY=sk_live_...` and `token:ghp_...` expose the value). A key/value check catches a credential
-- name followed by a value: `name=<8+ chars>` (env/URL form) or `name: <8+ chars with a digit>` (prose form; the digit
-- keeps "password: rotate monthly" acceptable). Mirrored in packages/modules/brain/src/domain/secrets.ts (T-210 H-1).
create function brain.text_has_secret(p_text text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is not null and (
    core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', p_text))
    or p_text ~* '(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/=-]{20,}'
    or p_text ~* ('(secret|token|password|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|signing[-_]?key|client[-_]?secret|credential)s?["'']?'
                  || '([[:space:]]*=[[:space:]]*["'']?[^[:space:]"'']{8,}|[[:space:]]*:[[:space:]]*["'']?(?=[^[:space:]"'']*[0-9])[^[:space:]"'']{8,})')
    or exists (
      select 1 from pg_catalog.regexp_split_to_table(p_text, E'\n') l(line)
      where l.line <> '' and core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', l.line))
    )
    or exists (
      select 1 from pg_catalog.regexp_split_to_table(p_text, '[^A-Za-z0-9_:/.@?&#=%+~-]+') t(tok)
      where pg_catalog.length(t.tok) >= 8 and core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', t.tok))
    )
    or exists (
      select 1 from pg_catalog.regexp_split_to_table(p_text, '[^A-Za-z0-9_./+~-]+') t(tok)
      where pg_catalog.length(t.tok) >= 8 and core.jsonb_has_secret(pg_catalog.jsonb_build_object('v', t.tok))
    )
  );
$$;

-- Shared entry check of every writer: AAL2, a signed-in user (service_role has no auth.uid(), so it is refused), and the
-- owner role in an enabled lane. Returns the caller's uid. Not a definer function itself: it runs inside the callers'.
create function brain.assert_owner(p_lane text) returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' then
    raise exception 'brain: a signed-in session at aal2 is required' using errcode = '42501';
  end if;
  if p_lane is null or not core.has_lane_role(v_uid, p_lane, array['owner']) then
    raise exception 'brain: the owner role in this lane is required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

revoke all on function brain.valid_path(text), brain.document_kind(text), brain.text_has_secret(text),
  brain.assert_owner(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- brain.documents
create table brain.documents (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  owner_user_id uuid not null references core.users (id) on delete cascade,
  kind text not null check (kind in ('about_me', 'preferences', 'context', 'project_brief', 'project_handoff', 'note')),
  path text not null check (brain.valid_path(path)),
  body_md text not null check (pg_catalog.octet_length(body_md) <= 32768 and not brain.text_has_secret(body_md)),
  version integer not null default 1 check (version >= 1),
  updated_by uuid not null references core.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = brain.document_kind(path)),
  unique (lane_id, owner_user_id, path),
  unique (id, lane_id)
);
comment on table brain.documents is
  'Owner-authored brain pages (T-210). One row per (lane, owner, path). Written only by brain.document_save.';
create index documents_lane_id_idx on brain.documents (lane_id);
create trigger documents_identity before update on brain.documents
  for each row execute function core.forbid_identity_change('lane_id', 'owner_user_id', 'path', 'kind');

-- ---------------------------------------------------------------- brain.document_versions (append-only, last 20)
create table brain.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  -- kind and owner_user_id are copied from the document by the trigger below (the RLS policy needs them here).
  kind text not null,
  owner_user_id uuid not null,
  version integer not null check (version >= 1),
  body_md text not null check (pg_catalog.octet_length(body_md) <= 32768 and not brain.text_has_secret(body_md)),
  saved_by uuid not null references core.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  foreign key (document_id, lane_id) references brain.documents (id, lane_id) on update restrict on delete cascade,
  unique (document_id, version)
);
comment on table brain.document_versions is
  'Content of each saved version of a document (T-210), pruned to the last 20 by brain.document_save. Append-only.';
create index document_versions_lane_id_idx on brain.document_versions (lane_id);

create function brain.document_versions_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'brain.document_versions is append-only' using errcode = '42501';
  end if;
  select d.kind, d.owner_user_id into new.kind, new.owner_user_id
  from brain.documents d where d.id = new.document_id and d.lane_id = new.lane_id;
  if not found then
    raise exception 'brain.document_versions: unknown document' using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function brain.document_versions_guard() from public, anon, authenticated;
create trigger document_versions_insert before insert on brain.document_versions
  for each row execute function brain.document_versions_guard();
create trigger document_versions_no_update before update on brain.document_versions
  for each row execute function brain.document_versions_guard();

-- ---------------------------------------------------------------- brain.employees
create table brain.employees (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  owner_user_id uuid not null references core.users (id) on delete cascade,
  role_key text not null check (role_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null check (name = btrim(name) and pg_catalog.length(name) between 1 and 100),
  instructions_md text not null default '' check (pg_catalog.octet_length(instructions_md) <= 32768 and not brain.text_has_secret(instructions_md)),
  -- Validated by employeeConfigSchema (T-211). Until then only: a JSON object, at most 32 KB, no credential-like keys or values.
  config jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(config) = 'object' and pg_catalog.octet_length(config::text) <= 32768 and not core.jsonb_has_secret(config)),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  version integer not null default 1 check (version >= 1),
  updated_by uuid not null references core.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, owner_user_id, role_key)
);
comment on table brain.employees is
  'AI employee profiles (T-210): prose instructions + config (jsonb; schema in T-211). Written only by brain.employee_save.';
create index employees_lane_id_idx on brain.employees (lane_id);
create trigger employees_identity before update on brain.employees
  for each row execute function core.forbid_identity_change('lane_id', 'owner_user_id', 'role_key');

-- ---------------------------------------------------------------- brain.skills
create table brain.skills (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  owner_user_id uuid not null references core.users (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9-]{1,59}$'),
  title text not null check (title = btrim(title) and pg_catalog.length(title) between 1 and 200),
  body_md text not null check (pg_catalog.octet_length(body_md) <= 32768 and not brain.text_has_secret(body_md)),
  version integer not null default 1 check (version >= 1),
  updated_by uuid not null references core.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lane_id, owner_user_id, key)
);
comment on table brain.skills is 'Method prompts an employee can load by name (T-210). Written only by brain.skill_save.';
create index skills_lane_id_idx on brain.skills (lane_id);
create trigger skills_identity before update on brain.skills
  for each row execute function core.forbid_identity_change('lane_id', 'owner_user_id', 'key');

-- ---------------------------------------------------------------- brain.imports and brain.import_candidates (§7a)
-- No storage_path: the raw upload is never persisted. Candidates are fact + at most 300 characters of evidence.
create table brain.imports (
  id uuid primary key default gen_random_uuid(),
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  user_id uuid not null references core.users (id) on delete cascade,
  source text not null check (source in ('claude_paste', 'chatgpt_paste', 'claude_export', 'chatgpt_export', 'brain_zip')),
  status text not null default 'extracting' check (status in ('extracting', 'review', 'done', 'failed')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, lane_id),
  check ((status in ('done', 'failed')) = (finished_at is not null))
);
comment on table brain.imports is 'Context import runs (T-210; the pipeline is T-214). No raw upload is stored.';
create index imports_lane_id_idx on brain.imports (lane_id);
create index imports_user_id_idx on brain.imports (user_id);
create trigger imports_identity before update on brain.imports
  for each row execute function core.forbid_identity_change('lane_id', 'user_id', 'source');

create table brain.import_candidates (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null,
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  user_id uuid not null references core.users (id) on delete cascade,
  fact text not null check (pg_catalog.length(fact) between 1 and 1000 and not brain.text_has_secret(fact)),
  evidence text check (pg_catalog.length(evidence) <= 300 and not brain.text_has_secret(evidence)),
  target_path text not null check (brain.valid_path(target_path)),
  target_lane text not null references core.lanes (code) on update restrict on delete restrict,
  flags text[] not null default '{}' check (flags <@ array['possible_nl_content', 'instruction_dropped']::text[]),
  decision text not null default 'pending' check (decision in ('pending', 'keep', 'skip')),
  created_at timestamptz not null default now(),
  foreign key (import_id, lane_id) references brain.imports (id, lane_id) on update restrict on delete cascade,
  -- A candidate flagged as possibly Nichols Law content keeps no evidence quote (spec §7a).
  check (not ('possible_nl_content' = any (flags)) or evidence is null)
);
comment on table brain.import_candidates is
  'Short-lived import candidates (T-210). Deleted when the import is done and, at the latest, 23 h after creation by core.brain_import_purge.';
create index import_candidates_lane_id_idx on brain.import_candidates (lane_id);
create index import_candidates_import_id_idx on brain.import_candidates (import_id);
create index import_candidates_created_at_idx on brain.import_candidates (created_at);
create trigger import_candidates_identity before update on brain.import_candidates
  for each row execute function core.forbid_identity_change('import_id', 'lane_id', 'user_id', 'fact', 'evidence', 'target_path', 'target_lane', 'flags');

-- ---------------------------------------------------------------- RLS
alter table brain.documents enable row level security;
alter table brain.document_versions enable row level security;
alter table brain.employees enable row level security;
alter table brain.skills enable row level security;
alter table brain.imports enable row level security;
alter table brain.import_candidates enable row level security;

create policy documents_select on brain.documents
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
    and (kind not in ('about_me', 'preferences') or owner_user_id = (select auth.uid()))
  );
create policy document_versions_select on brain.document_versions
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
    and (kind not in ('about_me', 'preferences') or owner_user_id = (select auth.uid()))
  );
-- Standard lane expression. An employee runs only for its owner_user_id (checked by the runner, T-213).
create policy employees_select on brain.employees
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
  );
create policy skills_select on brain.skills
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
  );
create policy imports_select on brain.imports
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
    and user_id = (select auth.uid())
  );
create policy import_candidates_select on brain.import_candidates
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
    and user_id = (select auth.uid())
    and created_at > now() - interval '24 hours'
  );

revoke all on all tables in schema brain from public, anon, authenticated, service_role;
grant select on brain.documents, brain.document_versions, brain.employees, brain.skills, brain.imports, brain.import_candidates
  to authenticated;
-- Jobs read employee profiles and skills (T-213); nothing writes except the definer functions.
grant select on brain.employees, brain.skills to service_role;

-- ---------------------------------------------------------------- writers (security definer, reviewed)

-- Saves a page with an optimistic version check. p_if_version = 0 means "create" (the page must not exist); otherwise it
-- must equal the stored version, else SQLSTATE 40001 'brain: version_conflict'. Saving identical text is a no-op (same version).
-- Keeps the last 20 versions. Addressed by (lane, auth.uid(), path): a caller can only ever touch their own pages.
create function brain.document_save(p_lane text, p_path text, p_body text, p_if_version integer)
returns table (o_id uuid, o_version integer, o_updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := brain.assert_owner(p_lane);
  v_row brain.documents%rowtype;
begin
  if not brain.valid_path(p_path) then
    raise exception 'brain: invalid path' using errcode = '22023';
  end if;
  if p_body is null or pg_catalog.octet_length(p_body) > 32768 then
    raise exception 'brain: body is missing or larger than 32 KB' using errcode = '22023';
  end if;
  if p_if_version is null or p_if_version < 0 then
    raise exception 'brain: if_version is required' using errcode = '22023';
  end if;
  if brain.text_has_secret(p_body) then
    raise exception 'brain: content looks like a credential' using errcode = '22023';
  end if;

  select d.* into v_row from brain.documents d
  where d.lane_id = p_lane and d.owner_user_id = v_uid and d.path = p_path
  for update;
  if not found then
    if p_if_version <> 0 then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end if;
    begin
      insert into brain.documents (lane_id, owner_user_id, kind, path, body_md, updated_by)
      values (p_lane, v_uid, brain.document_kind(p_path), p_path, p_body, v_uid)
      returning * into v_row;
    exception when unique_violation then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end;
  else
    if v_row.version <> p_if_version then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end if;
    if v_row.body_md = p_body then
      return query select v_row.id, v_row.version, v_row.updated_at;
      return;
    end if;
    update brain.documents d
    set body_md = p_body, version = d.version + 1, updated_by = v_uid, updated_at = now()
    where d.id = v_row.id
    returning * into v_row;
  end if;

  insert into brain.document_versions (document_id, lane_id, version, body_md, saved_by)
  values (v_row.id, v_row.lane_id, v_row.version, v_row.body_md, v_uid);
  delete from brain.document_versions v where v.document_id = v_row.id and v.version <= v_row.version - 20;

  return query select v_row.id, v_row.version, v_row.updated_at;
end;
$$;
comment on function brain.document_save(text, text, text, integer) is
  'Brain page writer (T-210). aal2 + owner of the lane; own pages only; optimistic if_version; secret scan; keeps 20 versions.';

-- Creates or updates the caller's employee profile for a role. Same version rules as document_save. `config` is only
-- shape-checked here (object, size, no credentials); employeeConfigSchema and the permission ceiling are T-211.
create function brain.employee_save(
  p_lane text, p_role_key text, p_name text, p_instructions_md text, p_config jsonb, p_status text, p_if_version integer
)
returns table (o_id uuid, o_version integer, o_updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := brain.assert_owner(p_lane);
  v_row brain.employees%rowtype;
begin
  if p_role_key is null or p_role_key !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'brain: invalid role key' using errcode = '22023';
  end if;
  if p_name is null or p_name <> pg_catalog.btrim(p_name) or pg_catalog.length(p_name) not between 1 and 100 then
    raise exception 'brain: invalid name' using errcode = '22023';
  end if;
  if p_instructions_md is null or pg_catalog.octet_length(p_instructions_md) > 32768 then
    raise exception 'brain: instructions are missing or larger than 32 KB' using errcode = '22023';
  end if;
  if p_config is null or pg_catalog.jsonb_typeof(p_config) <> 'object' or pg_catalog.octet_length(p_config::text) > 32768 then
    raise exception 'brain: config must be a JSON object of at most 32 KB' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('draft', 'active', 'paused') then
    raise exception 'brain: invalid status' using errcode = '22023';
  end if;
  if p_if_version is null or p_if_version < 0 then
    raise exception 'brain: if_version is required' using errcode = '22023';
  end if;
  if brain.text_has_secret(p_instructions_md) or brain.text_has_secret(p_name) or core.jsonb_has_secret(p_config) then
    raise exception 'brain: content looks like a credential' using errcode = '22023';
  end if;

  select e.* into v_row from brain.employees e
  where e.lane_id = p_lane and e.owner_user_id = v_uid and e.role_key = p_role_key
  for update;
  if not found then
    if p_if_version <> 0 then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end if;
    begin
      insert into brain.employees (lane_id, owner_user_id, role_key, name, instructions_md, config, status, updated_by)
      values (p_lane, v_uid, p_role_key, p_name, p_instructions_md, p_config, p_status, v_uid)
      returning * into v_row;
    exception when unique_violation then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end;
  else
    if v_row.version <> p_if_version then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end if;
    update brain.employees e
    set name = p_name, instructions_md = p_instructions_md, config = p_config, status = p_status,
        version = e.version + 1, updated_by = v_uid, updated_at = now()
    where e.id = v_row.id
    returning * into v_row;
  end if;
  return query select v_row.id, v_row.version, v_row.updated_at;
end;
$$;
comment on function brain.employee_save(text, text, text, text, jsonb, text, integer) is
  'Employee profile writer (T-210). aal2 + owner of the lane; own profiles only; optimistic if_version; secret scan.';

-- Creates or updates the caller's skill (method prompt) by key. Same version rules.
create function brain.skill_save(p_lane text, p_key text, p_title text, p_body text, p_if_version integer)
returns table (o_id uuid, o_version integer, o_updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := brain.assert_owner(p_lane);
  v_row brain.skills%rowtype;
begin
  if p_key is null or p_key !~ '^[a-z][a-z0-9-]{1,59}$' then
    raise exception 'brain: invalid skill key' using errcode = '22023';
  end if;
  if p_title is null or p_title <> pg_catalog.btrim(p_title) or pg_catalog.length(p_title) not between 1 and 200 then
    raise exception 'brain: invalid title' using errcode = '22023';
  end if;
  if p_body is null or pg_catalog.octet_length(p_body) > 32768 then
    raise exception 'brain: body is missing or larger than 32 KB' using errcode = '22023';
  end if;
  if p_if_version is null or p_if_version < 0 then
    raise exception 'brain: if_version is required' using errcode = '22023';
  end if;
  if brain.text_has_secret(p_body) or brain.text_has_secret(p_title) then
    raise exception 'brain: content looks like a credential' using errcode = '22023';
  end if;

  select s.* into v_row from brain.skills s
  where s.lane_id = p_lane and s.owner_user_id = v_uid and s.key = p_key
  for update;
  if not found then
    if p_if_version <> 0 then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end if;
    begin
      insert into brain.skills (lane_id, owner_user_id, key, title, body_md, updated_by)
      values (p_lane, v_uid, p_key, p_title, p_body, v_uid)
      returning * into v_row;
    exception when unique_violation then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end;
  else
    if v_row.version <> p_if_version then
      raise exception 'brain: version_conflict' using errcode = '40001';
    end if;
    update brain.skills s
    set title = p_title, body_md = p_body, version = s.version + 1, updated_by = v_uid, updated_at = now()
    where s.id = v_row.id
    returning * into v_row;
  end if;
  return query select v_row.id, v_row.version, v_row.updated_at;
end;
$$;
comment on function brain.skill_save(text, text, text, text, integer) is
  'Skill writer (T-210). aal2 + owner of the lane; own skills only; optimistic if_version; secret scan.';

-- Records the caller's keep/skip decisions on an open import's candidates and returns the kept facts. With p_finish the
-- import becomes 'done' and ALL its candidates are deleted (spec §7a). p_decisions: [{"id": uuid, "decision": "keep"|"skip"}].
create function brain.import_decide(p_lane text, p_import_id uuid, p_decisions jsonb, p_finish boolean default false)
returns table (o_candidate_id uuid, o_fact text, o_target_path text, o_target_lane text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := brain.assert_owner(p_lane);
  v_imp brain.imports%rowtype;
  v_el jsonb;
  v_id uuid;
  v_dec text;
  v_n integer;
begin
  if p_import_id is null or p_decisions is null or pg_catalog.jsonb_typeof(p_decisions) <> 'array'
     or pg_catalog.jsonb_array_length(p_decisions) > 500 then
    raise exception 'brain: decisions must be an array of at most 500' using errcode = '22023';
  end if;
  select i.* into v_imp from brain.imports i
  where i.id = p_import_id and i.lane_id = p_lane and i.user_id = v_uid
  for update;
  if not found then
    raise exception 'brain: import not found' using errcode = '42501';
  end if;
  if v_imp.status <> 'review' then
    raise exception 'brain: import is not open for decisions' using errcode = '55000';
  end if;
  if v_imp.created_at <= now() - interval '24 hours' then
    raise exception 'brain: import expired' using errcode = '55000';
  end if;

  for v_el in select e.value from pg_catalog.jsonb_array_elements(p_decisions) e loop
    if pg_catalog.jsonb_typeof(v_el) <> 'object' or pg_catalog.jsonb_typeof(v_el -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_el -> 'decision') <> 'string' or (v_el ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'brain: invalid decision' using errcode = '22023';
    end if;
    v_id := (v_el ->> 'id')::uuid;
    v_dec := v_el ->> 'decision';
    if v_dec not in ('keep', 'skip') then
      raise exception 'brain: invalid decision' using errcode = '22023';
    end if;
    update brain.import_candidates c set decision = v_dec
    where c.id = v_id and c.import_id = v_imp.id and c.lane_id = v_imp.lane_id and c.user_id = v_uid;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'brain: unknown candidate' using errcode = '42501';
    end if;
  end loop;

  return query
    select c.id, c.fact, c.target_path, c.target_lane
    from brain.import_candidates c
    where c.import_id = v_imp.id and c.lane_id = v_imp.lane_id and c.user_id = v_uid and c.decision = 'keep'
    order by c.created_at, c.id;

  if p_finish then
    delete from brain.import_candidates c where c.import_id = v_imp.id and c.lane_id = v_imp.lane_id;
    update brain.imports i set status = 'done', finished_at = now() where i.id = v_imp.id;
  end if;
end;
$$;
comment on function brain.import_decide(text, uuid, jsonb, boolean) is
  'Import review (T-210). aal2 + owner; own open import only; keep/skip per candidate; finish = done + candidates deleted.';

revoke all on function brain.document_save(text, text, text, integer),
  brain.employee_save(text, text, text, text, jsonb, text, integer),
  brain.skill_save(text, text, text, text, integer),
  brain.import_decide(text, uuid, jsonb, boolean) from public, anon;
grant execute on function brain.document_save(text, text, text, integer),
  brain.employee_save(text, text, text, text, jsonb, text, integer),
  brain.skill_save(text, text, text, text, integer),
  brain.import_decide(text, uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------- core wrappers (the exposed schema)
-- Thin SECURITY INVOKER functions: RLS applies to the reads; the writers do their own checks. Nothing here widens access.

create function core.brain_home_lane() returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select d.lane_id from brain.documents d
  where d.kind = 'about_me' and d.owner_user_id = (select auth.uid())
  order by d.created_at, d.lane_id
  limit 1;
$$;
comment on function core.brain_home_lane() is
  'Brain (T-210): the lane that already holds the caller''s About-Me page (their home lane), or null. Invoker: RLS applies.';

create function core.brain_documents_list(p_lane text, p_prefix text default null)
returns table (path text, kind text, version integer, updated_at timestamptz, is_mine boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  return query
    select d.path, d.kind, d.version, d.updated_at, d.owner_user_id = (select auth.uid())
    from brain.documents d
    where d.lane_id = p_lane
      and (p_prefix is null or d.path like pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%')
    order by d.path, (d.owner_user_id = (select auth.uid())) desc
    limit 500;
end;
$$;
comment on function core.brain_documents_list(text, text) is
  'Brain (T-210): page metadata of the lane (no body; is_mine = the caller''s own copy), at most 500. Invoker: RLS applies (About-Me and Preferences: author only).';

create function core.brain_document_get(p_lane text, p_path text)
returns table (id uuid, path text, kind text, body_md text, version integer, updated_at timestamptz, is_mine boolean)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null or p_path is null then
    raise exception 'lane and path are required' using errcode = '22004';
  end if;
  return query
    select d.id, d.path, d.kind, d.body_md, d.version, d.updated_at, d.owner_user_id = (select auth.uid())
    from brain.documents d
    where d.lane_id = p_lane and d.path = p_path and (d.kind not in ('about_me', 'preferences') or d.owner_user_id = (select auth.uid()))
    order by (d.owner_user_id = (select auth.uid())) desc, d.updated_at desc
    limit 1;
end;
$$;
comment on function core.brain_document_get(text, text) is
  'Brain (T-210): one page, the caller''s own copy first. Invoker: RLS applies.';

create function core.brain_document_versions(p_lane text, p_path text)
returns table (version integer, body_md text, saved_by uuid, created_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null or p_path is null then
    raise exception 'lane and path are required' using errcode = '22004';
  end if;
  return query
    select v.version, v.body_md, v.saved_by, v.created_at
    from brain.document_versions v
    join brain.documents d on d.id = v.document_id and d.lane_id = v.lane_id
    where v.lane_id = p_lane and d.path = p_path and d.owner_user_id = (select auth.uid())
    order by v.version desc
    limit 20;
end;
$$;
comment on function core.brain_document_versions(text, text) is
  'Brain (T-210): the caller''s own saved versions of a page (newest first, at most 20). Invoker: RLS applies.';

create function core.brain_document_save(p_lane text, p_path text, p_body text, p_if_version integer)
returns table (o_id uuid, o_version integer, o_updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query select * from brain.document_save(p_lane, p_path, p_body, p_if_version);
end;
$$;
comment on function core.brain_document_save(text, text, text, integer) is 'Brain (T-210): exposes brain.document_save (which checks everything itself).';

create function core.brain_employees_list(p_lane text)
returns table (id uuid, is_mine boolean, role_key text, name text, instructions_md text, config jsonb, status text, version integer, updated_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  return query
    select e.id, e.owner_user_id = (select auth.uid()), e.role_key, e.name, e.instructions_md, e.config, e.status, e.version, e.updated_at
    from brain.employees e
    where e.lane_id = p_lane
    order by e.role_key, e.owner_user_id
    limit 100;
end;
$$;
comment on function core.brain_employees_list(text) is 'Brain (T-210): the lane''s employee profiles. Invoker: RLS applies.';

create function core.brain_employee_save(
  p_lane text, p_role_key text, p_name text, p_instructions_md text, p_config jsonb, p_status text, p_if_version integer
)
returns table (o_id uuid, o_version integer, o_updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query select * from brain.employee_save(p_lane, p_role_key, p_name, p_instructions_md, p_config, p_status, p_if_version);
end;
$$;
comment on function core.brain_employee_save(text, text, text, text, jsonb, text, integer) is 'Brain (T-210): exposes brain.employee_save.';

create function core.brain_skills_list(p_lane text)
returns table (id uuid, is_mine boolean, key text, title text, body_md text, version integer, updated_at timestamptz)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  return query
    select s.id, s.owner_user_id = (select auth.uid()), s.key, s.title, s.body_md, s.version, s.updated_at
    from brain.skills s
    where s.lane_id = p_lane
    order by s.key, s.owner_user_id
    limit 100;
end;
$$;
comment on function core.brain_skills_list(text) is 'Brain (T-210): the lane''s skills. Invoker: RLS applies.';

create function core.brain_skill_save(p_lane text, p_key text, p_title text, p_body text, p_if_version integer)
returns table (o_id uuid, o_version integer, o_updated_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query select * from brain.skill_save(p_lane, p_key, p_title, p_body, p_if_version);
end;
$$;
comment on function core.brain_skill_save(text, text, text, text, integer) is 'Brain (T-210): exposes brain.skill_save.';

create function core.brain_import_decide(p_lane text, p_import_id uuid, p_decisions jsonb, p_finish boolean default false)
returns table (o_candidate_id uuid, o_fact text, o_target_path text, o_target_lane text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query select * from brain.import_decide(p_lane, p_import_id, p_decisions, p_finish);
end;
$$;
comment on function core.brain_import_decide(text, uuid, jsonb, boolean) is 'Brain (T-210): exposes brain.import_decide.';

revoke all on function core.brain_home_lane(), core.brain_documents_list(text, text), core.brain_document_get(text, text),
  core.brain_document_versions(text, text), core.brain_document_save(text, text, text, integer),
  core.brain_employees_list(text), core.brain_employee_save(text, text, text, text, jsonb, text, integer),
  core.brain_skills_list(text), core.brain_skill_save(text, text, text, text, integer),
  core.brain_import_decide(text, uuid, jsonb, boolean) from public, anon;
grant execute on function core.brain_home_lane(), core.brain_documents_list(text, text), core.brain_document_get(text, text),
  core.brain_document_versions(text, text), core.brain_document_save(text, text, text, integer),
  core.brain_employees_list(text), core.brain_employee_save(text, text, text, text, jsonb, text, integer),
  core.brain_skills_list(text), core.brain_skill_save(text, text, text, text, integer),
  core.brain_import_decide(text, uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------- retention: import candidates (hourly job)
-- Deletes the lane's import candidates created more than 23 h ago (the hourly job then keeps every candidate under 24 h)
-- and closes imports still open after 24 h as 'failed' (their candidates are gone). Definer: service_role has no grants on
-- brain. Lane-checked; returns the number of candidates deleted. Cross-lane and floor tests: 250.
create function core.brain_import_purge(p_lane text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if not exists (select 1 from core.lanes l where l.code = p_lane and l.enabled) then
    raise exception 'lane is not enabled' using errcode = '42501';
  end if;
  delete from brain.import_candidates c where c.lane_id = p_lane and c.created_at <= now() - interval '23 hours';
  get diagnostics v_n = row_count;
  update brain.imports i set status = 'failed', finished_at = now()
  where i.lane_id = p_lane and i.status in ('extracting', 'review') and i.created_at <= now() - interval '24 hours';
  return v_n;
end;
$$;
comment on function core.brain_import_purge(text) is
  'Retention (T-210, spec §7a): deletes a lane''s import candidates older than 23 h and closes imports open after 24 h. Lane-checked; service_role only.';
revoke all on function core.brain_import_purge(text) from public, anon, authenticated;
grant execute on function core.brain_import_purge(text) to service_role;
