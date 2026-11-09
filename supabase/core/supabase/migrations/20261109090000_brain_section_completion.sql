-- T-227: explicit per-section completion of the brain setup interview (docs/specs/brain-interview.md; follow-up to T-226).
-- A row means "this user finished this section in this lane's brain": set when the user clicks Save on a section (even when
-- every value is a kept default and no brain page changes) or "Nothing to add". Derived rules cannot tell a kept default
-- from "never answered", so completion is stored. The section ids are the interview bank's group ids; the bank lives in
-- code, so brain.valid_section lists them and a unit test (packages/modules/brain bank.test.ts) keeps the two in step.
--
-- Access
--   * Reads: RLS, AAL2 + the lane in core.allowed_lanes(uid, 'brain') + own rows only (custom policy, catalog custom_policy_ok).
--   * Writes: NO user DML. The one writer is the reviewed security-definer brain.section_complete: AAL2, owner role in the
--     lane, rows addressed by auth.uid() (never a caller-supplied user), section ids validated, idempotent (first time wins).
--     service_role has no access (jobs never read or write completion).
--   * Reached from the app through the SECURITY INVOKER wrappers core.brain_section_completions / core.brain_section_complete.
-- Backfill of sections saved before this table existed is done by the app on first load through the same writer (the
-- derivation lives in the interview engine, not in SQL); see packages/modules/brain/src/server/interview.ts.

create function brain.valid_section(p_section text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_section is not null and p_section = any (array['A-1', 'A-2', 'A-3', 'A-4', 'B-1', 'B-2', 'B-3', 'B-4', 'B-5', 'B-6']);
$$;
revoke all on function brain.valid_section(text) from public, anon, authenticated;

create table brain.section_completions (
  lane_id text not null references core.lanes (code) on update restrict on delete restrict,
  user_id uuid not null references core.users (id) on delete cascade,
  section_id text not null check (brain.valid_section(section_id)),
  completed_at timestamptz not null default now(),
  primary key (lane_id, user_id, section_id)
);
comment on table brain.section_completions is
  'Setup interview sections the user has finished (T-227): Save (even with kept defaults) or Nothing to add. Written only by brain.section_complete.';
create trigger section_completions_identity before update on brain.section_completions
  for each row execute function core.forbid_identity_change('lane_id', 'user_id', 'section_id');

alter table brain.section_completions enable row level security;
create policy section_completions_select on brain.section_completions
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and lane_id = any ((select core.allowed_lanes((select auth.uid()), 'brain'))::text[])
    and user_id = (select auth.uid())
  );
revoke all on brain.section_completions from public, anon, authenticated, service_role;
grant select on brain.section_completions to authenticated;

-- Marks sections complete for the caller. Idempotent: an existing row keeps its first completed_at. Returns the caller's
-- rows for the given sections.
create function brain.section_complete(p_lane text, p_sections text[])
returns table (o_section_id text, o_completed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := brain.assert_owner(p_lane);
begin
  if p_sections is null or pg_catalog.cardinality(p_sections) not between 1 and 20
     or exists (select 1 from pg_catalog.unnest(p_sections) s where s is null or not brain.valid_section(s)) then
    raise exception 'brain: unknown section' using errcode = '22023';
  end if;
  insert into brain.section_completions (lane_id, user_id, section_id)
  select p_lane, v_uid, s from pg_catalog.unnest(p_sections) s
  on conflict (lane_id, user_id, section_id) do nothing;
  return query
    select c.section_id, c.completed_at from brain.section_completions c
    where c.lane_id = p_lane and c.user_id = v_uid and c.section_id = any (p_sections)
    order by c.section_id;
end;
$$;
comment on function brain.section_complete(text, text[]) is
  'Setup interview completion (T-227). aal2 + owner role; own rows only (auth.uid()); known section ids only; idempotent.';
revoke all on function brain.section_complete(text, text[]) from public, anon;
grant execute on function brain.section_complete(text, text[]) to authenticated;

create function core.brain_section_completions(p_lane text)
returns table (section_id text, completed_at timestamptz)
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
    select c.section_id, c.completed_at from brain.section_completions c
    where c.lane_id = p_lane and c.user_id = (select auth.uid())
    order by c.section_id;
end;
$$;
comment on function core.brain_section_completions(text) is 'Brain (T-227): the caller''s completed setup sections in a lane. Invoker: RLS applies.';

create function core.brain_section_complete(p_lane text, p_sections text[])
returns table (o_section_id text, o_completed_at timestamptz)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query select * from brain.section_complete(p_lane, p_sections);
end;
$$;
comment on function core.brain_section_complete(text, text[]) is 'Brain (T-227): exposes brain.section_complete.';

revoke all on function core.brain_section_completions(text), core.brain_section_complete(text, text[]) from public, anon;
grant execute on function core.brain_section_completions(text), core.brain_section_complete(text, text[]) to authenticated;
