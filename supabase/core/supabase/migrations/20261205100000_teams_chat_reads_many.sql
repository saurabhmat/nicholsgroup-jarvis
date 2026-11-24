-- T-295: one query for the read markers of ALL of a person's Teams connections in a lane (docs/specs/messages.md 22.5 "Unread per connection": "read in ONE database query").
-- core.teams_chat_reads_list reads one connection; with several accounts per person (T-294) that would be one query each. This is the same thin SECURITY INVOKER wrapper over
-- comms.teams_chat_reads for a LIST of connection ids (at most 5, the most a person may connect): Row-level security decides what is returned (the owner of the Teams connection at AAL2
-- only; another person's, another lane's, an unknown id and an admin's rows are simply not returned). At most 1,000 rows per connection, newest touched first (the same cap as the
-- single-connection wrapper). Nothing is written, no policy and no table changes; the existing wrapper is unchanged.
-- Tests: 333_teams_chat_reads_many.test.sql.
create function core.teams_chat_reads_list_many(p_lane text, p_connections uuid[])
returns table (connection_id uuid, chat_id text, read_through timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.connection_id, r.chat_id, r.read_through
  from (
    select x.connection_id, x.chat_id, x.read_through,
           pg_catalog.row_number() over (partition by x.connection_id order by x.updated_at desc) as rn
    from comms.teams_chat_reads x
    where x.lane_id = p_lane
      and x.connection_id = any (p_connections)
      and pg_catalog.cardinality(p_connections) between 1 and 5
  ) r
  where r.rn <= 1000;
$$;
comment on function core.teams_chat_reads_list_many(text, uuid[]) is
  'T-295: the caller''s own read markers of up to 5 Teams connections in one lane, in one query (connection id, chat id, time). Invoker: RLS applies (owner of the connection, AAL2); anyone else gets no rows; more than 5 ids, none or null returns nothing.';
revoke all on function core.teams_chat_reads_list_many(text, uuid[]) from public, anon, service_role;
grant execute on function core.teams_chat_reads_list_many(text, uuid[]) to authenticated;
