-- Brain: refuse sensitive numbers (T-210 follow-up; decided by Saurabh, Nov 7, 2026; architecture "never stored" list,
-- security review M-2 and the follow-up review). Refused in brain page bodies and paths, version rows, employee names,
-- instructions and config, skill titles and bodies, and import candidate facts, evidence and target paths:
--   ssn  ###-##-#### not inside a longer dashed number;
--   card digits in a card layout (one run of 13-19, 4-4-4-4 with an optional 1-3 tail, 4-6-4/5) passing Luhn; groups
--        may be split by one or two spaces, dashes or dots, and a following expiry/CVV does not hide the number;
--   bank an account number (8-17 digits) after "account"/"acct", a routing number (9 digits) after "routing"/"ABA", or
--        an IBAN after "IBAN"; markdown between label and number (`**`, `|`, `:`, `-`, a newline) is skipped.
-- Text is NFKC-normalised and Unicode dashes become "-" first. Phone numbers, dates, last-4s and short ledger account
-- numbers ("Account 400100") still save. Known false positive, accepted: an unbroken 13-19 digit id passing Luhn.
-- Enforced by a BEFORE INSERT OR UPDATE trigger on every brain text table (writers and direct inserts alike). The error
-- names the kind (`brain: sensitive_<kind> ...`) and never echoes the text. Mirrored in
-- packages/modules/brain/src/domain/sensitive.ts; shared cases in tests/fixtures/brain_sensitive_cases.json.

create function brain.luhn_ok(p_digits text) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_sum int := 0;
  v_d int;
  v_len int := pg_catalog.length(p_digits);
begin
  for i in 0 .. v_len - 1 loop
    v_d := pg_catalog.ascii(pg_catalog.substr(p_digits, v_len - i, 1)) - 48;
    if i % 2 = 1 then
      v_d := v_d * 2;
      if v_d > 9 then v_d := v_d - 9; end if;
    end if;
    v_sum := v_sum + v_d;
  end loop;
  return v_sum % 10 = 0;
end;
$$;

-- Group lengths that look like a written card number.
create function brain.card_layout(p_lengths int[]) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_k int := coalesce(pg_catalog.array_length(p_lengths, 1), 0);
  v_total int := 0;
begin
  for i in 1 .. v_k loop
    v_total := v_total + p_lengths[i];
  end loop;
  if v_total < 13 or v_total > 19 then
    return false;
  end if;
  if v_k = 1 then
    return true;
  end if;
  if v_k = 3 and p_lengths[1] = 4 and p_lengths[2] = 6 and p_lengths[3] in (4, 5) then
    return true;
  end if;
  if v_k >= 4 then
    for i in 1 .. v_k - 1 loop
      if p_lengths[i] <> 4 then
        return false;
      end if;
    end loop;
    return p_lengths[v_k] between 1 and 4;
  end if;
  return false;
end;
$$;

-- 'ssn', 'card', 'bank' or null.
create function brain.sensitive_number_kind(p_text text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
  v_lower text;
  v_seq text;
  v_groups text[];
  v_lengths int[];
  v_digits text;
  v_n int;
  c_gap constant text := '(?:[ \t]{0,3}(?:number|num|no|nr)(?![a-z]))?[ \t*_|:#.=\n-]{0,10}(?:is[ \t]{1,3})?';
  c_not_date constant text := '(?![0-9]{4}-[0-9]{2}-[0-9]{2}(?![0-9]))(?![0-9]{1,2}-[0-9]{1,2}-[0-9]{2,4}(?![0-9]))';
begin
  if p_text is null then
    return null;
  end if;
  v_text := pg_catalog.translate(pg_catalog.normalize(p_text, 'NFKC'), E'‐‑‒–—―−', '-------');

  if v_text ~ '(?<![0-9])(?<![0-9]-)[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9])(?!-[0-9])' then
    return 'ssn';
  end if;

  for v_seq in select m[1] from pg_catalog.regexp_matches(v_text, '([0-9]+(?:[ \t.-]{1,2}[0-9]+)*)', 'g') m loop
    v_groups := pg_catalog.regexp_split_to_array(v_seq, '[^0-9]+');
    v_n := pg_catalog.array_length(v_groups, 1);
    for i in 1 .. v_n loop
      v_digits := '';
      v_lengths := '{}';
      for j in i .. v_n loop
        -- Prune (same result as card_layout): every group before the last is 4 digits, except 4-6-x.
        exit when j > i and pg_catalog.length(v_groups[j - 1]) <> 4
                  and not (j = i + 2 and pg_catalog.length(v_groups[i]) = 4 and pg_catalog.length(v_groups[j - 1]) = 6);
        v_digits := v_digits || v_groups[j];
        v_lengths := v_lengths || pg_catalog.length(v_groups[j]);
        exit when pg_catalog.length(v_digits) > 19;
        if pg_catalog.length(v_digits) >= 13 and brain.card_layout(v_lengths) and brain.luhn_ok(v_digits) then
          return 'card';
        end if;
      end loop;
    end loop;
  end loop;

  v_lower := pg_catalog.lower(v_text);
  if v_lower ~ ('(?:^|[^a-z])(?:account|acct)(?![a-z])' || c_gap || c_not_date || '[0-9](?:[ -]?[0-9]){7,16}(?![0-9/])')
     or v_lower ~ ('(?:^|[^a-z])(?:routing|aba)(?![a-z])' || c_gap || '[0-9](?:[ -]?[0-9]){8}(?![0-9/])')
     or v_lower ~ '(?:^|[^a-z])iban(?![a-z])[ \t*_|:#.=\n-]{0,10}[a-z]{2}[0-9]{2}(?:[ -]?[a-z0-9]){10,30}' then
    return 'bank';
  end if;
  return null;
end;
$$;

-- Trigger: TG_ARGV lists the columns to screen (text, or jsonb screened as its JSON text). An unknown column name fails
-- loudly instead of silently screening nothing (review L-1).
create function brain.refuse_sensitive_numbers() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row jsonb := pg_catalog.to_jsonb(new);
  v_kind text;
  v_value jsonb;
begin
  for i in 0 .. tg_nargs - 1 loop
    if not (v_row ? tg_argv[i]) then
      raise exception 'brain.refuse_sensitive_numbers: unknown column %', tg_argv[i];
    end if;
    v_value := v_row -> tg_argv[i];
    v_kind := brain.sensitive_number_kind(case pg_catalog.jsonb_typeof(v_value) when 'string' then v_value #>> '{}' else v_value::text end);
    if v_kind is not null then
      raise exception 'brain: sensitive_% (content contains a sensitive number and was not saved)', v_kind using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function brain.luhn_ok(text), brain.card_layout(int[]), brain.sensitive_number_kind(text), brain.refuse_sensitive_numbers()
  from public, anon, authenticated, service_role;

create trigger documents_sensitive before insert or update on brain.documents
  for each row execute function brain.refuse_sensitive_numbers('path', 'body_md');
create trigger document_versions_sensitive before insert on brain.document_versions
  for each row execute function brain.refuse_sensitive_numbers('body_md');
create trigger employees_sensitive before insert or update on brain.employees
  for each row execute function brain.refuse_sensitive_numbers('name', 'instructions_md', 'config');
create trigger skills_sensitive before insert or update on brain.skills
  for each row execute function brain.refuse_sensitive_numbers('title', 'body_md');
create trigger import_candidates_sensitive before insert or update on brain.import_candidates
  for each row execute function brain.refuse_sensitive_numbers('fact', 'evidence', 'target_path');
