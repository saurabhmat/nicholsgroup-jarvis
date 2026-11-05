-- conn.sync support (T-038): core.sync_cursor_put (compare-and-swap) and the one-running-sync-per-connection index.
begin;
select plan(22);

update core.lanes set enabled = true where code = 'APK';
insert into core.connections (id, lane_id, provider, external_account_id, status) values
  ('00000000-0000-4000-8000-000000000381', 'PKG', 'quickbooks', 'realm-38-a', 'active'),
  ('00000000-0000-4000-8000-000000000382', 'APK', 'quickbooks', 'realm-38-b', 'active'),
  ('00000000-0000-4000-8000-000000000383', 'PKG', 'quickbooks', 'realm-38-c', 'reconnect_required'),
  ('00000000-0000-4000-8000-000000000384', 'PKG', 'quickbooks', 'realm-38-d', 'degraded');

select ok(has_function_privilege('service_role', 'core.sync_cursor_put(text, uuid, text, text, text)', 'execute'), 'service_role executes sync_cursor_put');
select ok(not has_function_privilege('authenticated', 'core.sync_cursor_put(text, uuid, text, text, text)', 'execute')
          and not has_function_privilege('anon', 'core.sync_cursor_put(text, uuid, text, text, text)', 'execute'),
          'authenticated and anon cannot execute sync_cursor_put');

set local role service_role;
select is(core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'default', null, 'c1'), true, 'first write (expected none) stores the cursor');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000381', 'default'), 'c1', 'the cursor reads back');
select is(core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'default', null, 'c2'), false, 'a stale writer (expected none, but one is stored) writes nothing');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000381', 'default'), 'c1', 'the stored cursor is unchanged after the refused write');
select is(core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'default', 'c1', 'c2'), true, 'a writer holding the stored cursor advances it');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000381', 'default'), 'c2', 'the new cursor reads back');
select throws_ok($$select core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'mail', null, 'x')$$, '22023', null, 'the mail cursor cannot be written (it moves only with its pages)');
select throws_ok($$select core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'calendar', null, 'x')$$, '22023', null, 'the calendar cursor cannot be written');
select throws_ok($$select core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', null, null, 'x')$$, '22004', null, 'a null stream is refused');
select is(core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000384', 'default', null, 'd1'), true, 'a degraded connection may still store its cursor');
select is(core.sync_cursor_put('APK', '00000000-0000-4000-8000-000000000382', 'default', null, 'a1'), true, 'the APK connection stores its own cursor');
select is(core.sync_cursor_get('PKG', '00000000-0000-4000-8000-000000000381', 'default'), 'c2', 'and the PKG cursor is untouched by it');
select throws_ok($$select core.sync_cursor_put('APK', '00000000-0000-4000-8000-000000000381', 'default', null, 'x')$$, '42501', null, 'cross-lane: a PKG connection cannot be written as APK');
select throws_ok($$select core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000383', 'default', null, 'x')$$, '42501', null, 'a connection that needs reconnecting is refused');
select throws_ok($$select core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'Bad Stream', null, 'x')$$, '22023', null, 'a malformed stream is refused');
select throws_ok($$select core.sync_cursor_put('PKG', '00000000-0000-4000-8000-000000000381', 'default', null, '')$$, '22023', null, 'an empty cursor is refused');
reset role;
update core.lanes set enabled = false where code = 'APK';
set local role service_role;
select throws_ok($$select core.sync_cursor_put('APK', '00000000-0000-4000-8000-000000000382', 'default', 'a1', 'a2')$$, '42501', null, 'a disabled lane is refused');
reset role;
update core.lanes set enabled = true where code = 'APK';

-- one running sync per connection
insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000381', 'full', 'schedule');
select throws_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000381', 'full', 'manual')$$,
  '23505', null, 'a second running sync for the same connection is refused');
update core.sync_runs set status = 'succeeded', finished_at = now() where connection_id = '00000000-0000-4000-8000-000000000381';
select lives_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000381', 'incremental', 'schedule')$$,
  'a new run may start once the previous one finished');
select lives_ok($$insert into core.sync_runs (lane_id, connection_id, kind, trigger) values ('PKG', '00000000-0000-4000-8000-000000000384', 'full', 'schedule')$$,
  'another connection may run at the same time (the index is per connection)');

select * from finish();
rollback;
