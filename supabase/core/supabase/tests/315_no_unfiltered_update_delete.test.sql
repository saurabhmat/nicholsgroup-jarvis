-- T-242 regression: no function body may run an UPDATE or DELETE without a top-level WHERE clause.
-- Why: PostgREST connects as `authenticator`, whose role settings preload pg-safeupdate (Supabase default, locally too). safeupdate
-- refuses such a statement with SQLSTATE 21000 ("UPDATE requires a WHERE clause"). An RPC with one works in the SQL Editor and in these
-- tests (they run as postgres, without safeupdate) and fails only through the API: production's normalizer failed exactly so.
-- The check reads every plpgsql/sql function of the app's schemas: comments, string literals and nested dollar-quoted text are
-- removed; for each UPDATE ... SET / DELETE FROM (ON CONFLICT DO UPDATE excluded: safeupdate does not check it) the rest of its own
-- parenthesis group is taken with nested parentheses removed, and it must contain WHERE (a WHERE inside a subquery does not count).
begin;
select plan(4);

create function pg_temp.top_level(p text) returns text language plpgsql as $$
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
end $$;

-- Unfiltered UPDATE/DELETE statements of one function body (text of each offending statement, shortened).
create function pg_temp.unfiltered(p_src text) returns setof text language plpgsql as $$
declare
  src text := p_src; stmt text; m record; rest text; d int; e int; ch text;
begin
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  src := regexp_replace(src, '/\*.*?\*/', '', 'g');
  src := regexp_replace(src, '\$([a-z_]*)\$.*?\$\1\$', ' ', 'g');
  src := regexp_replace(src, '''(?:[^'']|'''')*''', '''''', 'g');
  foreach stmt in array regexp_split_to_array(src, ';') loop
    for m in select (regexp_matches(stmt, '(?:^|[^a-z_])((update\s+[a-z_."]+(\s+(as\s+)?[a-z_]+)?\s+set\s)|(delete\s+from\s))', 'gi'))[1] as hit loop
      rest := substr(stmt, strpos(stmt, m.hit));
      if regexp_replace(left(stmt, strpos(stmt, m.hit) - 1), '\s+$', '') ~* 'do$' then continue; end if; -- ON CONFLICT DO UPDATE
      d := 0; e := length(rest);
      for i in 1 .. length(rest) loop
        ch := substr(rest, i, 1);
        if ch = '(' then d := d + 1;
        elsif ch = ')' then if d = 0 then e := i - 1; exit; end if; d := d - 1;
        end if;
      end loop;
      if pg_temp.top_level(left(rest, e)) !~* '\mwhere\M' then
        return next left(regexp_replace(left(rest, e), '\s+', ' ', 'g'), 120);
      end if;
    end loop;
  end loop;
end $$;

-- The check itself catches the production case and its cousins (self-test).
select is((select count(*)::int from pg_temp.unfiltered($f$ update pg_temp.q_pay p set ent = coalesce((select min(x) from t a where a.id = p.id), 'x'); $f$)), 1,
          'self-test: a WHERE only inside a subquery is not a WHERE (the production statement)');
select is((select count(*)::int from pg_temp.unfiltered($f$ with w as (delete from t returning 1) select 1; update t set a = 1 where b = 2;
                                                         insert into t values (1) on conflict (a) do update set a = excluded.a; $f$)), 1,
          'self-test: an unfiltered DELETE in a CTE is found; a filtered UPDATE and ON CONFLICT DO UPDATE are not');

-- Every function of the app's schemas.
select is(
  (select coalesce(array_agg(n.nspname || '.' || p.proname || ': ' || u order by 1), '{}')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join lateral pg_temp.unfiltered(p.prosrc) u
   where n.nspname in ('core', 'fin', 'brief', 'act', 'brain', 'audit', 'comms', 'cal', 'raw', 'public')
     and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))),
  '{}'::text[],
  'no UPDATE or DELETE without a top-level WHERE in any app function (pg-safeupdate refuses them through PostgREST)');
select ok((select prosrc ~ 'where p\.id is not null' from pg_proc where oid = 'core.fin_qbo_normalize(text, uuid)'::regprocedure),
          'the normalizer''s payment-entity update has its explicit predicate');

select * from finish();
rollback;
