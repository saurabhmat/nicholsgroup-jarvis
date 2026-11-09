-- T-220: memory import from Claude / ChatGPT / a brain folder into the brain (spec brain-and-employees §3, §7a; D-39, D-40).
--
--  1. New lane-policy category 'brain_import' (D-40). The import's model call is not an assistant tool, but it sends the
--     user's pasted text to the model, so it runs under the HOME lane's policy: core.ai_tool_gate(lane, 'brain', 'brain_import')
--     is the one check (aal2, owner/member role, lane enabled, category allowed, assistant + brain views, rate limit).
--     The lane_policies check and the gate's category list gain the new name; nothing else about either changes.
--  2. brain.import_candidates gains target_section (the heading the fact would go under) and may target the Personal
--     Assistant profile (path Employees/Personal-Assistant.md, which is not a brain page path).
--  3. The reviewed writer brain.import_create(lane, source, candidates) opens an import in 'review' and inserts its candidates
--     in ONE call. aal2 + owner role; rows are addressed by auth.uid() (never a caller-supplied user); source limited to the
--     four extraction sources (brain_zip maps pages without a model and has no candidates); at most 100 candidates; at most
--     20 imports per user per hour; targets limited to the four pages the interview writes and to lanes the caller may open
--     with the brain view; a candidate flagged possible_nl_content keeps no evidence (forced null here as well as by the check).
--     No raw upload is stored anywhere (D-39): a candidate is a short fact and a quote of at most 300 characters.
--  4. The reader core.brain_import_candidates (security invoker: RLS applies, own rows, under 24 h).
-- Production: this migration is applied by hand after part 7 (H-043 also adds 'brain_import' to PKG's lane policy by hand).

alter table core.lane_policies drop constraint lane_policies_llm_allowed_categories_check;
alter table core.lane_policies add constraint lane_policies_llm_allowed_categories_check
  check (llm_allowed_categories <@ array['email', 'calendar', 'docs', 'finance', 'finance_summary', 'tasks', 'brain_import']::text[]);

-- The gate, unchanged except the accepted categories (a copy of 20261108090000_ai_tool_gate.sql with 'brain_import' added).
create or replace function core.ai_tool_gate(p_lane text, p_view text, p_category text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_enabled boolean;
  v_categories text[];
  v_window timestamptz;
  v_calls integer;
  -- The limit is not a parameter: a member calling this RPC directly must not be able to pick a window that resets
  -- the counter (T-101 security review M1). Per-lane override: lane_config.assistant.tool_calls_per_minute (1..1000).
  v_limit integer := 30;
  v_raw text;
begin
  if p_lane is null or p_lane !~ '^[A-Z]{1,8}$' then
    raise exception 'invalid lane' using errcode = '22023';
  end if;
  if p_view is null or not (p_view = any (core.view_names())) then
    raise exception 'invalid view' using errcode = '22023';
  end if;
  if p_category is null or not (p_category = any (array['email', 'calendar', 'docs', 'finance', 'finance_summary', 'tasks', 'brain_import']::text[])) then
    raise exception 'invalid category' using errcode = '22023';
  end if;

  if v_uid is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    return jsonb_build_object('allowed', false, 'reason', 'mfa_required', 'role', null);
  end if;

  select m.role, l.enabled into v_role, v_enabled
  from core.memberships m
  join core.lanes l on l.code = m.lane_id
  where m.user_id = v_uid and m.lane_id = p_lane;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'not_member', 'role', null);
  end if;
  -- admin_technical has no access to any content (spec §3), whatever views exist.
  if v_role = 'admin_technical' then
    return jsonb_build_object('allowed', false, 'reason', 'role_denied', 'role', v_role);
  end if;
  if not v_enabled then
    return jsonb_build_object('allowed', false, 'reason', 'lane_disabled', 'role', v_role);
  end if;

  select lp.llm_allowed_categories into v_categories from core.lane_policies lp where lp.lane_id = p_lane;
  if not (p_category = any (coalesce(v_categories, '{}'::text[]))) then
    return jsonb_build_object('allowed', false, 'reason', 'category_denied', 'role', v_role);
  end if;

  if not (p_lane = any (core.allowed_lanes(v_uid, 'assistant'))) or not (p_lane = any (core.allowed_lanes(v_uid, p_view))) then
    return jsonb_build_object('allowed', false, 'reason', 'view_denied', 'role', v_role);
  end if;

  select c.config -> 'assistant' ->> 'tool_calls_per_minute' into v_raw
  from core.lane_config c where c.lane_id = p_lane order by c.version desc limit 1;
  if v_raw ~ '^[0-9]{1,4}$' and v_raw::integer between 1 and 1000 then
    v_limit := v_raw::integer;
  end if;

  -- Fixed 60-second window; the counter only increments while under the limit, so a denied call does not extend it.
  v_window := pg_catalog.date_trunc('minute', now());
  delete from core.ai_tool_rate r where r.lane_id = p_lane and r.user_id = v_uid and r.window_start < v_window;
  insert into core.ai_tool_rate as r (lane_id, user_id, window_start, calls)
  values (p_lane, v_uid, v_window, 1)
  on conflict (lane_id, user_id, window_start) do update set calls = r.calls + 1 where r.calls < v_limit
  returning r.calls into v_calls;
  if v_calls is null then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited', 'role', v_role);
  end if;

  return jsonb_build_object('allowed', true, 'reason', null, 'role', v_role);
end;
$$;
comment on function core.ai_tool_gate(text, text, text) is
  'Assistant policy gate (T-101): aal2, membership/role, lane enabled, llm_allowed_categories, assistant + required view, rate limit (30/min or lane_config.assistant.tool_calls_per_minute), for auth.uid() only. Returns {allowed, reason, role}; no data.';
revoke all on function core.ai_tool_gate(text, text, text) from public, anon, service_role;
grant execute on function core.ai_tool_gate(text, text, text) to authenticated;

-- ---------------------------------------------------------------- candidates: target section, PA profile target
alter table brain.import_candidates add column target_section text
  check (target_section is null or target_section ~ '^[0-9A-Za-z][0-9A-Za-z .,&''-]{0,79}$');
alter table brain.import_candidates drop constraint import_candidates_target_path_check;
alter table brain.import_candidates add constraint import_candidates_target_path_check
  check (brain.valid_path(target_path) or target_path = 'Employees/Personal-Assistant.md');
drop trigger import_candidates_identity on brain.import_candidates;
create trigger import_candidates_identity before update on brain.import_candidates
  for each row execute function core.forbid_identity_change('import_id', 'lane_id', 'user_id', 'fact', 'evidence', 'target_path', 'target_section', 'target_lane', 'flags');

-- ---------------------------------------------------------------- writer
-- p_candidates: [{"fact": text, "evidence": text|null, "target_path": text, "target_section": text, "target_lane": text, "flags": [text]}]
create function brain.import_create(p_lane text, p_source text, p_candidates jsonb)
returns table (o_import_id uuid, o_candidate_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := brain.assert_owner(p_lane);
  v_import uuid;
  v_el jsonb;
  v_fact text;
  v_evidence text;
  v_flags text[];
  v_path text;
  v_target_lane text;
  v_open text[] := (core.allowed_lanes(v_uid, 'brain'))::text[];
begin
  if p_source is null or p_source not in ('claude_paste', 'chatgpt_paste', 'claude_export', 'chatgpt_export') then
    raise exception 'brain: invalid import source' using errcode = '22023';
  end if;
  if p_candidates is null or pg_catalog.jsonb_typeof(p_candidates) <> 'array'
     or pg_catalog.jsonb_array_length(p_candidates) not between 1 and 100 then
    raise exception 'brain: candidates must be an array of 1 to 100' using errcode = '22023';
  end if;
  if (select count(*) from brain.imports i where i.user_id = v_uid and i.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'brain: too many imports' using errcode = '54000';
  end if;

  insert into brain.imports (lane_id, user_id, source, status) values (p_lane, v_uid, p_source, 'review') returning id into v_import;

  for v_el in select e.value from pg_catalog.jsonb_array_elements(p_candidates) e loop
    if pg_catalog.jsonb_typeof(v_el) <> 'object' or pg_catalog.jsonb_typeof(v_el -> 'fact') <> 'string'
       or pg_catalog.jsonb_typeof(v_el -> 'target_path') <> 'string' or pg_catalog.jsonb_typeof(v_el -> 'target_lane') <> 'string'
       or pg_catalog.jsonb_typeof(v_el -> 'target_section') <> 'string'
       or pg_catalog.jsonb_typeof(coalesce(v_el -> 'evidence', 'null'::jsonb)) not in ('string', 'null')
       or pg_catalog.jsonb_typeof(coalesce(v_el -> 'flags', '[]'::jsonb)) <> 'array' then
      raise exception 'brain: invalid candidate' using errcode = '22023';
    end if;
    v_fact := v_el ->> 'fact';
    v_evidence := v_el ->> 'evidence';
    v_path := v_el ->> 'target_path';
    v_target_lane := v_el ->> 'target_lane';
    select coalesce(pg_catalog.array_agg(f), '{}') into v_flags from pg_catalog.jsonb_array_elements_text(coalesce(v_el -> 'flags', '[]'::jsonb)) f;
    if pg_catalog.length(v_fact) not between 1 and 1000 or (v_evidence is not null and pg_catalog.length(v_evidence) > 300)
       or not (v_flags <@ array['possible_nl_content', 'instruction_dropped']::text[])
       or v_path not in ('Context/About-Me.md', 'Context/Preferences.md', 'Context/Work.md', 'Employees/Personal-Assistant.md')
       or not (v_target_lane = any (v_open)) or p_lane <> any (v_open) then
      raise exception 'brain: invalid candidate' using errcode = '22023';
    end if;
    -- A possible Nichols Law candidate keeps no quote (spec §7a), whatever the caller sent.
    if 'possible_nl_content' = any (v_flags) then
      v_evidence := null;
    end if;
    insert into brain.import_candidates (import_id, lane_id, user_id, fact, evidence, target_path, target_section, target_lane, flags)
    values (v_import, p_lane, v_uid, v_fact, v_evidence, v_path, v_el ->> 'target_section', v_target_lane, v_flags)
    returning id into o_candidate_id;
    o_import_id := v_import;
    return next;
  end loop;
end;
$$;
comment on function brain.import_create(text, text, jsonb) is
  'Import writer (T-220). aal2 + owner role; own rows (auth.uid()); extraction sources only; 1-100 candidates; 20 imports/hour; targets limited to the four interview pages and to lanes the caller may open; NL candidates keep no quote.';
revoke all on function brain.import_create(text, text, jsonb) from public, anon;
grant execute on function brain.import_create(text, text, jsonb) to authenticated;

create function core.brain_import_create(p_lane text, p_source text, p_candidates jsonb)
returns table (o_import_id uuid, o_candidate_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query select * from brain.import_create(p_lane, p_source, p_candidates);
end;
$$;
comment on function core.brain_import_create(text, text, jsonb) is 'Brain (T-220): exposes brain.import_create.';

-- The caller's own open import candidates (RLS: aal2, allowed lane, own rows, under 24 h).
create function core.brain_import_candidates(p_lane text, p_import_id uuid)
returns table (o_id uuid, o_fact text, o_evidence text, o_target_path text, o_target_section text, o_target_lane text, o_flags text[], o_decision text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_lane is null or p_import_id is null then
    raise exception 'lane and import are required' using errcode = '22004';
  end if;
  return query
    select c.id, c.fact, c.evidence, c.target_path, c.target_section, c.target_lane, c.flags, c.decision
    from brain.import_candidates c
    join brain.imports i on i.id = c.import_id and i.lane_id = c.lane_id
    where c.import_id = p_import_id and c.lane_id = p_lane and c.user_id = (select auth.uid())
      and i.user_id = (select auth.uid()) and i.status = 'review'
    order by c.created_at, c.id;
end;
$$;
comment on function core.brain_import_candidates(text, uuid) is 'Brain (T-220): the caller''s candidates of one open import. Invoker: RLS applies.';

revoke all on function core.brain_import_create(text, text, jsonb), core.brain_import_candidates(text, uuid) from public, anon;
grant execute on function core.brain_import_create(text, text, jsonb), core.brain_import_candidates(text, uuid) to authenticated;
