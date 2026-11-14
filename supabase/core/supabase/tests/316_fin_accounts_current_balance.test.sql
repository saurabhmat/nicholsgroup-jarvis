-- T-243: fin.accounts.current_balance (QuickBooks Account.CurrentBalance) set by the normalizer. Synthetic data only.
-- Covered: the column (numeric(18,2), nullable), stored on insert, rounded to cents, null when the raw account has none or a non-number,
-- updated when the raw balance changes (the "is distinct from" tuple), unchanged on an identical re-run, and the normalizer still runs
-- through a PostgREST-like session. Cash from these balances is tested in 300_home_finance; its cross-lane and AAL1 denial too.
begin;
select plan(14);

update core.lanes set enabled = true where code = 'PKG';
insert into core.connections (id, lane_id, provider, external_account_id, status)
values ('00000000-0000-4000-8000-0000000003e2', 'PKG', 'quickbooks', '9341450000000316', 'active');
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{qbo}', '{"realm_id": "9341450000000316", "entity_mapping_mode": "file"}') from core.lane_config_current where lane_id = 'PKG';
insert into core.lane_config (lane_id, version, config)
select lane_id, version + 1, jsonb_set(config, '{entities,own_entity}', '"PKG"') from core.lane_config_current where lane_id = 'PKG';

select col_type_is('fin', 'accounts', 'current_balance', 'numeric(18,2)', 'current_balance is numeric(18,2)');
select col_is_null('fin', 'accounts', 'current_balance', 'current_balance is nullable');

create temp table src (id text, p jsonb) on commit drop;
insert into src values
 ('71', '{"Id":"71","Name":"Synthetic Checking","AccountType":"Bank","CurrentBalance":1234.567}'),
 ('72', '{"Id":"72","Name":"Synthetic Savings","AccountType":"Bank","CurrentBalance":-20}'),
 ('73', '{"Id":"73","Name":"Synthetic No Balance","AccountType":"Bank"}'),
 ('74', '{"Id":"74","Name":"Synthetic Text Balance","AccountType":"Bank","CurrentBalance":"12.00"}'),
 ('75', '{"Id":"75","Name":"Synthetic Receivable","AccountType":"Accounts Receivable","CurrentBalance":500.00}');
insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash, source_updated_at, deleted, synced_at)
select 'PKG', '00000000-0000-4000-8000-0000000003e2', 'quickbooks', 'Account', id, p, md5(p::text), now() - interval '1 hour', false, now() from src;

-- As the API runs it: service_role through the authenticator-style session.
set local role service_role;
create temp table r1 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e2') as out;
reset role;
select is((select out #>> '{accounts,inserted}' from r1), '5', 'five accounts inserted');
select is((select current_balance from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '71'), 1234.57::numeric, 'the balance is stored, rounded to cents');
select is((select current_balance from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '72'), -20.00::numeric, 'a negative balance is kept');
select is((select current_balance is null from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '73'), true, 'no CurrentBalance in the raw account: null, never zero');
select is((select current_balance is null from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '74'), true, 'a non-number CurrentBalance is null');

-- A newer version of the raw account with a new balance (and the same everything else) is applied.
update raw.source_records set payload = jsonb_set(payload, '{CurrentBalance}', '2000.10'), payload_hash = 'v2'
where connection_id = '00000000-0000-4000-8000-0000000003e2' and object_type = 'Account' and external_id = '71';
update raw.source_records set payload = payload || '{"CurrentBalance": 33.00}', payload_hash = 'v2'
where connection_id = '00000000-0000-4000-8000-0000000003e2' and object_type = 'Account' and external_id = '73';
set local role service_role;
create temp table r2 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e2') as out;
create temp table r3 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e2') as out;
reset role;
select is((select out #>> '{accounts,updated}' from r2), '2', 'only the two changed balances are updated');
select is((select current_balance from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '71'), 2000.10::numeric, 'a changed balance is updated');
select is((select current_balance from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '73'), 33.00::numeric, 'a missing balance is filled by a re-normalize');
select is((select out #>> '{accounts,updated}' from r3), '0', 'an identical re-run changes nothing');

-- T-243 review: a tombstone keeps no figure. Account 77 is live with a balance, then becomes a payroll account (tombstoned); 78 is deleted in QuickBooks.
insert into raw.source_records (lane_id, connection_id, provider, object_type, external_id, payload, payload_hash, source_updated_at, deleted, synced_at) values
  ('PKG', '00000000-0000-4000-8000-0000000003e2', 'quickbooks', 'Account', '77', '{"Id":"77","Name":"Synthetic Holding","AccountType":"Bank","CurrentBalance":10}', 'a77', now() - interval '1 hour', false, now()),
  ('PKG', '00000000-0000-4000-8000-0000000003e2', 'quickbooks', 'Account', '78', '{"Id":"78","Name":"Synthetic Other","AccountType":"Bank","CurrentBalance":20}', 'a78', now() - interval '1 hour', false, now());
set local role service_role;
create temp table r4 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e2') as out;
reset role;
select is((select current_balance from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id = '77'), 10.00::numeric, 'a live account has its balance');
update raw.source_records set payload = '{"Id":"77","Name":"Payroll Clearing Wages","AccountType":"Bank","CurrentBalance":10}', payload_hash = 'b77'
where connection_id = '00000000-0000-4000-8000-0000000003e2' and object_type = 'Account' and external_id = '77';
update raw.source_records set deleted = true, payload_hash = 'b78', source_updated_at = now()
where connection_id = '00000000-0000-4000-8000-0000000003e2' and object_type = 'Account' and external_id = '78';
set local role service_role;
create temp table r5 on commit drop as select core.fin_qbo_normalize('PKG', '00000000-0000-4000-8000-0000000003e2') as out;
reset role;
select is((select count(*)::int from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id in ('77', '78') and deleted), 2, 'a payroll account and a deleted account are tombstoned');
select is((select count(*)::int from fin.accounts where connection_id = '00000000-0000-4000-8000-0000000003e2' and source_id in ('77', '78') and current_balance is null), 2, 'a tombstoned account keeps no balance');

select * from finish();
rollback;
