-- T-242 regression: no function body may run an UPDATE or DELETE without a top-level WHERE clause.
-- Why: PostgREST connects as `authenticator`, whose role settings preload pg-safeupdate (Supabase default, locally too). safeupdate
-- refuses such a statement with SQLSTATE 21000 ("UPDATE requires a WHERE clause"). An RPC with one works in the SQL Editor and in these
-- tests (they run as postgres, without safeupdate) and fails only through the API: production's normalizer failed exactly so.
-- The check reads every plpgsql/sql function of the app's schemas with a one-pass scanner (comments, string literals including E''
-- escapes, dollar quotes with any tag, and quoted identifiers are removed); every UPDATE ... SET / DELETE FROM must have a WHERE at its
-- own statement level (a WHERE inside a subquery does not count). Dynamic SQL (EXECUTE text) is not parsed; a separate assertion bans
-- UPDATE/DELETE there. Not covered: pg_cron jobs, rules, and supabase-js .update()/.delete() calls without a filter (also refused).
begin;
select plan(11);

create function pg_temp.top_level(p text) returns text language plpgsql as $fn$
declare d int := 0; ch text; out text := '';
begin
  for i in 1 .. length(p) loop
    ch := substr(p, i, 1);
    if ch = '(' then d := d + 1;
    elsif ch = ')' then d := greatest(d - 1, 0);
    elsif d = 0 then out := out || ch;
    end if;
  end loop;
  return out;
end $fn$;

-- One left-to-right pass: what remains is code only. Literals become '', dollar-quoted text a space, quoted identifiers "q".
create function pg_temp.code_only(p text) returns text language plpgsql as $fn$
declare i int := 1; n int := length(p); ch text; out text := ''; tag text; e int; esc boolean; q text := chr(39);
begin
  while i <= n loop
    ch := substr(p, i, 1);
    if substr(p, i, 2) = '--' then
      e := strpos(substr(p, i), chr(10));
      i := case when e = 0 then n + 1 else i + e end;
      out := out || chr(10);
    elsif substr(p, i, 2) = '/*' then
      e := strpos(substr(p, i + 2), '*/');
      i := case when e = 0 then n + 1 else i + 2 + e + 1 end;
      out := out || ' ';
    elsif ch = '$' and substr(p, i) ~ '^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$' then
      tag := substring(substr(p, i) from '^(\$[A-Za-z_0-9]*\$)');
      e := strpos(substr(p, i + length(tag)), tag);
      i := case when e = 0 then n + 1 else i + length(tag) + e - 1 + length(tag) end;
      out := out || ' ';
    elsif ch = q then
      esc := i > 1 and upper(substr(p, i - 1, 1)) = 'E' and (i = 2 or substr(p, i - 2, 1) !~ '[A-Za-z0-9_]');
      i := i + 1;
      while i <= n loop
        if esc and substr(p, i, 1) = chr(92) then i := i + 2;
        elsif substr(p, i, 2) = q || q then i := i + 2;
        elsif substr(p, i, 1) = q then i := i + 1; exit;
        else i := i + 1;
        end if;
      end loop;
      out := out || q || q;
    elsif ch = '"' then
      i := i + 1;
      while i <= n loop
        if substr(p, i, 2) = '""' then i := i + 2;
        elsif substr(p, i, 1) = '"' then i := i + 1; exit;
        else i := i + 1;
        end if;
      end loop;
      out := out || '"q"';
    else
      -- plain code: copy up to the next character that can start a comment, a quote or an identifier quote, in one step
      e := regexp_instr(p, '[-/$''"]', i + 1);
      if e = 0 then e := n + 1; end if;
      out := out || substr(p, i, e - i);
      i := e;
    end if;
  end loop;
  return out;
end $fn$;

-- Every UPDATE ... SET / DELETE FROM whose own statement level (to the end of its parenthesis group or the next ';') has no WHERE.
-- Each keyword is checked at its own position. Not statements: FOR [NO KEY] UPDATE, ON UPDATE / ON DELETE (foreign keys),
-- ON CONFLICT DO UPDATE (safeupdate does not check it), and an "update" word with no SET after it at its level.
create function pg_temp.unfiltered(p_src text) returns setof text language plpgsql as $fn$
declare
  code text := pg_temp.code_only(p_src); pos int := 1; p int; kw text; prev text; rest text; d int; e int; ch text; lvl text;
begin
  loop
    p := regexp_instr(code, '\m(update|delete\s+from)\M', pos, 1, 0, 'i');
    exit when p = 0;
    pos := p + 1;
    kw := lower(substr(code, p, 6));
    prev := lower(coalesce(substring(left(code, p - 1) from '([A-Za-z_]+)\s*$'), ''));
    if prev in ('for', 'key', 'on', 'do') then continue; end if;
    rest := substr(code, p);
    d := 0;
    e := length(rest);
    for i in 1 .. length(rest) loop
      ch := substr(rest, i, 1);
      if ch = '(' then d := d + 1;
      elsif ch = ')' then
        if d = 0 then e := i - 1; exit; end if;
        d := d - 1;
      elsif ch = ';' and d = 0 then e := i - 1; exit;
      end if;
    end loop;
    lvl := pg_temp.top_level(left(rest, e));
    if kw = 'update' and lvl !~* '\mset\M' then continue; end if;
    if lvl !~* '\mwhere\M' then
      return next left(regexp_replace(left(rest, e), '\s+', ' ', 'g'), 120);
    end if;
  end loop;
end $fn$;

-- ---------------------------------------------------------------- self-tests: what the check must find, and what it must not
select is((select count(*)::int from pg_temp.unfiltered($f$ update pg_temp.q_pay p set ent = coalesce((select min(x) from t a where a.id = p.id), 'x'); $f$)), 1,
          'found: a WHERE only inside a subquery is not a WHERE (the production statement)');
select is((select count(*)::int from pg_temp.unfiltered($f$ with a as (delete from t where x returning 1), b as (delete from u returning 1) select 1; $f$)), 1,
          'found: the second, unfiltered DELETE of two in one statement');
select is((select count(*)::int from pg_temp.unfiltered($f$ update fin.t2 set x = 1; update q_pay2 p1 set y = 2; $f$)), 2,
          'found: names and aliases with digits');
select is((select count(*)::int from pg_temp.unfiltered($f$ update only fin.t set x = 1; update "my table" set x = 1; update t * set x = 1; $f$)), 3,
          'found: UPDATE ONLY schema.t, a quoted name with a space, t *');
select is((select count(*)::int from pg_temp.unfiltered($f$ raise notice 'a -- b'; update t set a = 1; raise notice E'it\'s /*'; delete from u; $f$)), 2,
          'found: code after a literal holding --, /* or an escaped quote');
select is((select count(*)::int from pg_temp.unfiltered($f$ perform format($q$x$q$); update t set a = 1; perform format($q$y$q$); $f$)), 1,
          'found: code between two separate dollar quotes (not swallowed)');
select is((select count(*)::int from pg_temp.unfiltered($f$ perform $Q1$ update t set a = 1 $Q1$; update u set b = 1 where c; $f$)), 0,
          'not code: text in a dollar quote with an upper-case numbered tag; a filtered UPDATE');
select is((select count(*)::int from pg_temp.unfiltered($f$ select * from t for update; select * from t for no key update;
          create table x (a int references t on delete cascade on update cascade);
          insert into t values (1) on conflict (a) do update set a = excluded.a; select somewhere, "update" from t; update t set w = 1 where somewhere; $f$)), 0,
          'not flagged: FOR UPDATE, FOR NO KEY UPDATE, ON DELETE/UPDATE CASCADE, ON CONFLICT DO UPDATE, identifiers, a real WHERE');

-- ---------------------------------------------------------------- every function of the app's schemas
select is(
  (select coalesce(array_agg(n.nspname || '.' || p.proname || ': ' || u order by n.nspname, p.proname, u), '{}')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join lateral pg_temp.unfiltered(p.prosrc) u
   where n.nspname in ('core', 'fin', 'brief', 'act', 'brain', 'audit', 'comms', 'cal', 'raw', 'public')
     and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))),
  '{}'::text[],
  'no UPDATE or DELETE without a top-level WHERE in any app function (pg-safeupdate refuses them through PostgREST)');
select is(
  (select coalesce(array_agg(n.nspname || '.' || p.proname order by n.nspname, p.proname), '{}')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('core', 'fin', 'brief', 'act', 'brain', 'audit', 'comms', 'cal', 'raw', 'public')
     and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))
     and p.prosrc ~* '\mexecute\M[^;]*\m(update|delete)\M'),
  '{}'::text[],
  'no app function runs an UPDATE or DELETE as dynamic SQL (EXECUTE text is not parsed by the check above)');
select ok((select prosrc ~ 'where p\.id is not null' from pg_proc where oid = 'core.fin_qbo_normalize(text, uuid)'::regprocedure),
          'the normalizer''s payment-entity update has its explicit predicate');

select * from finish();
rollback;
