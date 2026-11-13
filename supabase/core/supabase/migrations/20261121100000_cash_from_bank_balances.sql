-- T-243: Cash (book balance) from the current balances of the lane's QuickBooks bank accounts, not the Balance Sheet.
--   * fin.accounts.current_balance numeric(18,2), nullable: QuickBooks Account.CurrentBalance, set by core.fin_qbo_normalize (this file
--     replaces the function from 20261120110000; only the accounts step changes: the column is set on insert and on update, and is part of
--     the "is distinct from" tuple). A row normalized before this column existed has null until the next normalize run.
--   * core.home_finance: Cash = sum of current_balance of active, not deleted bank accounts (is_bank) in fin.accounts that are listed in
--     lane_config.entities.bank_accounts with owner = own_entity (D-18). An account listed under another owner, or also listed under more
--     than one owner, or whose entity_code is another entity, is flagged shared. A bank account in no mapping is counted in cash_unmapped
--     and not summed. cash_as_of = the least of the last books sync and the last normalize. Only the lane's non-disconnected QuickBooks connections are read. The accounts tombstone also clears current_balance. Reasons: bank_mapping_missing, no_own_bank_accounts,
--     balance_unreadable (an own account has no balance yet: re-normalize fills it). The balance sheet reasons are gone.
--   Signature and output columns of core.home_finance are unchanged. No new table; the column inherits fin.accounts RLS.

alter table fin.accounts add column if not exists current_balance numeric(18,2);
comment on column fin.accounts.current_balance is
  'QuickBooks Account.CurrentBalance (book balance, T-243). Null when not yet normalized. Never an account number.';
comment on table fin.accounts is
  'QuickBooks chart of accounts (T-055) with the current book balance of each account (T-243: current_balance). No account/routing numbers.';

create or replace function core.fin_qbo_normalize(p_lane text, p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_features jsonb;
  v_cfg jsonb;
  v_mode text;
  v_own text;
  v_tracking boolean;
  v_fallback boolean;
  v_class_map jsonb;
  v_cust_map jsonb;
  v_bank_map jsonb;
  v_pay_ids text[];
  v_pay_subtypes text[];
  v_excl text[];
  v_cutoff timestamptz;
  v_full_started timestamptz;
  v_ins integer;
  v_upd integer;
  v_tomb integer;
  v_stale integer;
  v_counts jsonb := '{}'::jsonb;
  v_invalid integer;
  v_realloc_n integer;
  v_realloc jsonb;
  v_dead_deleted integer;
  v_dead_unseen integer;
  v_dead_payroll integer;
  v_dead_entity integer;
  v_dead_linked integer;
  v_refused_voided integer;
  v_unknown_invoice integer;
  v_non_usd integer;
  v_multi integer;
  v_fallback_rows integer := 0;
  v_unmapped integer;
  v_null_account integer;
  v_err_table text;
  v_err_constraint text;
  -- T-242: the section that was running, for the error message (fixed words only, never data).
  v_step text := 'config';
  v_entity_types constant text[] := array['Account', 'Customer', 'Vendor', 'Invoice', 'Bill', 'Payment', 'BillPayment', 'Purchase', 'Deposit', 'JournalEntry'];
  v_code_re constant text := '^[A-Za-z0-9_]{1,32}$';
  v_payroll_re constant text := '(payroll|salar(y|ies)|\ywages?\y|compensation)';
begin
  if p_lane is null or p_connection_id is null then
    raise exception 'fin.qbo_normalize: a lane and a connection are required' using errcode = '22004';
  end if;
  select c.features into v_features
  from core.connections c
  join core.lanes l on l.code = c.lane_id and l.enabled
  where c.id = p_connection_id and c.lane_id = p_lane and c.provider = 'quickbooks' and c.status in ('active', 'degraded');
  if not found then
    raise exception 'fin.qbo_normalize: usable QuickBooks connection not found in this lane' using errcode = '42501';
  end if;
  -- One normalizer per connection at a time (the second call waits, then finds nothing to change).
  perform pg_advisory_xact_lock(hashtextextended('fin_qbo_normalize:' || p_connection_id::text, 0));

  select c.config into v_cfg from core.lane_config_current c where c.lane_id = p_lane;
  v_mode := v_cfg #>> '{qbo,entity_mapping_mode}';
  if v_mode is null or v_mode not in ('file', 'file_class') then
    raise exception 'fin.qbo_normalize: lane_config has no QuickBooks entity mapping' using errcode = '22023';
  end if;

  -- Everything below runs in one block whose handler re-raises a constant message: a constraint violation would otherwise carry
  -- the failing row (names, amounts) in DETAIL to the caller and the Postgres log. Only the SQLSTATE and the table and
  -- constraint NAMES are kept (schema objects, never data). The checks above stay outside, with their own messages.
  begin
  -- ------------------------------------------------------------ lane_config (rule 2: nothing company-specific in code)
  v_own := v_cfg #>> '{entities,own_entity}';
  if v_own !~ v_code_re then v_own := null; end if;
  v_tracking := coalesce((v_features -> 'class_tracking') = 'true'::jsonb, false);
  v_fallback := v_mode = 'file_class' and not v_tracking;

  select coalesce(jsonb_object_agg(m.id, m.ent), '{}'::jsonb) into v_class_map from (
    select c.id, case when count(distinct e.key) = 1 then min(e.key) else '' end as ent
    from jsonb_each(case when jsonb_typeof(v_cfg #> '{entities,by_entity}') = 'object' then v_cfg #> '{entities,by_entity}' else '{}'::jsonb end) e
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.value -> 'qbo_class_ids') = 'array' then e.value -> 'qbo_class_ids' else '[]'::jsonb end) c(id)
    where e.key ~ v_code_re
    group by c.id) m;
  select coalesce(jsonb_object_agg(m.id, m.ent), '{}'::jsonb) into v_cust_map from (
    select c.id, case when count(distinct e.key) = 1 then min(e.key) else '' end as ent
    from jsonb_each(case when jsonb_typeof(v_cfg #> '{entities,by_entity}') = 'object' then v_cfg #> '{entities,by_entity}' else '{}'::jsonb end) e
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(e.value -> 'qbo_customer_ids') = 'array' then e.value -> 'qbo_customer_ids' else '[]'::jsonb end) c(id)
    where e.key ~ v_code_re
    group by c.id) m;
  select coalesce(jsonb_object_agg(b ->> 'qbo_account_id', b ->> 'owner_entity'), '{}'::jsonb) into v_bank_map
  from jsonb_array_elements(case when jsonb_typeof(v_cfg #> '{entities,bank_accounts}') = 'array' then v_cfg #> '{entities,bank_accounts}' else '[]'::jsonb end) b
  where jsonb_typeof(b -> 'qbo_account_id') = 'string' and (b ->> 'owner_entity') ~ v_code_re;

  v_pay_ids := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_cfg #> '{finance,payroll,account_ids}') = 'array' then v_cfg #> '{finance,payroll,account_ids}' else '[]'::jsonb end)), '{}');
  -- Same default as QBO_PAYROLL_SUBTYPES in packages/core/src/lane-config (a test pins the two lists together).
  v_pay_subtypes := case when jsonb_typeof(v_cfg #> '{finance,payroll,account_subtypes}') = 'array'
    then array(select lower(x) from jsonb_array_elements_text(v_cfg #> '{finance,payroll,account_subtypes}') x)
    else array['payrollexpenses', 'payrolltaxexpenses', 'payrollclearing', 'payrolltaxpayable', 'payrollwagepayable', 'directdepositpayable', 'costoflabor'] end;
  v_excl := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_cfg #> '{finance,payroll,excluded_entity_ids}') = 'array' then v_cfg #> '{finance,payroll,excluded_entity_ids}' else '[]'::jsonb end)), '{}');

  -- ------------------------------------------------------------ full-reload deletion gap
  select max(r.started_at) into v_full_started
  from core.sync_runs r
  where r.connection_id = p_connection_id and r.lane_id = p_lane and r.kind = 'full' and r.status = 'succeeded';
  v_cutoff := v_full_started - interval '15 minutes';
  -- Never move back: if sync_runs rows were ever trimmed, the cutoff of an earlier run stays in force (a dead record must not
  -- come back to life as a ledger row).
  select greatest(v_cutoff, max(r.unseen_cutoff)) into v_cutoff from fin.normalize_runs r where r.connection_id = p_connection_id;

  v_step := 'effective';
  -- ------------------------------------------------------------ working tables (dropped at the end)
  drop table if exists pg_temp.q_payroll, pg_temp.q_eff, pg_temp.q_cust, pg_temp.q_vend, pg_temp.q_inv, pg_temp.q_bill,
    pg_temp.q_pay, pg_temp.q_alloc, pg_temp.q_prow, pg_temp.q_txn, pg_temp.q_bpent, pg_temp.q_realloc;

  create temp table pg_temp.q_payroll (id text primary key) on commit drop;
  with recursive acct as (
    select r.external_id as id, r.payload #>> '{ParentRef,value}' as parent,
           (lower(coalesce(r.payload ->> 'AccountSubType', '')) = any (v_pay_subtypes)
            or coalesce(r.payload ->> 'Name', '') ~* v_payroll_re
            or coalesce(r.payload ->> 'FullyQualifiedName', '') ~* v_payroll_re) as hit
    from raw.source_records r
    where r.connection_id = p_connection_id and r.lane_id = p_lane and r.provider = 'quickbooks' and r.object_type = 'Account' and not r.deleted
  ), p as (
    select a.id from acct a where a.hit or a.id = any (v_pay_ids)
    union
    select a.id from acct a join p on a.parent = p.id
  )
  insert into pg_temp.q_payroll
  select id from p union select unnest(v_pay_ids)
  -- A raw Account tombstone: T-051 tombstones an account that became payroll (by subtype or name) and QuickBooks does not
  -- delete accounts that have transactions, so a transaction that references a deleted account is treated as payroll (fail closed).
  union select r.external_id from raw.source_records r
        where r.connection_id = p_connection_id and r.lane_id = p_lane and r.provider = 'quickbooks' and r.object_type = 'Account' and r.deleted;

  -- Effective records: every entity record of the connection with why = null when live, else the reason it is dead.
  create temp table pg_temp.q_eff on commit drop as
  select r.id as raw_id, r.object_type, r.external_id, r.payload, r.source_updated_at,
         case
           when r.deleted then 'deleted'
           when v_cutoff is not null and r.synced_at < v_cutoff then 'unseen'
           when r.object_type = 'Account' and r.external_id in (select id from pg_temp.q_payroll) then 'payroll'
           when r.object_type in ('Customer', 'Vendor') and r.external_id = any (v_excl) then 'entity'
           when r.object_type <> all (array['Account', 'Customer', 'Vendor'])
                and fin.qbo_account_refs(r.payload) && (select coalesce(array_agg(id), '{}') from pg_temp.q_payroll) then 'payroll'
           when r.object_type <> all (array['Account', 'Customer', 'Vendor']) and fin.qbo_is_employee(r.payload) then 'employee'
           when r.object_type <> all (array['Account', 'Customer', 'Vendor'])
                and fin.qbo_entity_refs(r.payload) && v_excl then 'entity'
         end as why
  from raw.source_records r
  where r.connection_id = p_connection_id and r.lane_id = p_lane and r.provider = 'quickbooks' and r.object_type = any (v_entity_types);
  create unique index on pg_temp.q_eff (object_type, external_id);

  -- T-051 re-review M2: a payment of a dead (deleted, unseen or excluded) invoice or bill gets no ledger rows.
  update pg_temp.q_eff p set why = 'linked'
  where p.why is null and p.object_type in ('Payment', 'BillPayment')
    and exists (
      select 1
      from jsonb_array_elements(case when jsonb_typeof(p.payload -> 'Line') = 'array' then p.payload -> 'Line' else '[]'::jsonb end) l
      cross join lateral jsonb_array_elements(case when jsonb_typeof(l -> 'LinkedTxn') = 'array' then l -> 'LinkedTxn' else '[]'::jsonb end) lt
      join pg_temp.q_eff t on t.object_type = lt ->> 'TxnType' and t.external_id = lt ->> 'TxnId'
      where (lt ->> 'TxnType') in ('Invoice', 'Bill') and t.why is not null);

  select count(*) filter (where why = 'deleted'), count(*) filter (where why = 'unseen'), count(*) filter (where why = 'payroll'),
         count(*) filter (where why = 'entity'), count(*) filter (where why = 'linked')
    into v_dead_deleted, v_dead_unseen, v_dead_payroll, v_dead_entity, v_dead_linked
  from pg_temp.q_eff;
  v_counts := v_counts || jsonb_build_object('dead_deleted', v_dead_deleted, 'dead_unseen', v_dead_unseen, 'dead_payroll', v_dead_payroll,
                                            'dead_entity', v_dead_entity, 'dead_linked', v_dead_linked);

  -- Names for customers and vendors (masked once, here).
  create temp table pg_temp.q_cust on commit drop as
  select e.external_id as id, left(fin.mask_digit_runs(e.payload ->> 'DisplayName'), 200) as name
  from pg_temp.q_eff e where e.object_type = 'Customer' and e.why is null and nullif(e.payload ->> 'DisplayName', '') is not null;
  create temp table pg_temp.q_vend on commit drop as
  select e.external_id as id, left(fin.mask_digit_runs(e.payload ->> 'DisplayName'), 200) as name
  from pg_temp.q_eff e where e.object_type = 'Vendor' and e.why is null and nullif(e.payload ->> 'DisplayName', '') is not null;

  v_step := 'accounts';
  -- ============================================================ accounts
  with w as (
    insert into fin.accounts as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, name, type, subtype,
                                   is_bank, entity_code, owner_entity_code, active, current_balance, deleted)
    select p_lane, p_connection_id, e.external_id, e.raw_id, e.source_updated_at,
           left(coalesce(nullif(fin.mask_digit_runs(coalesce(e.payload ->> 'FullyQualifiedName', e.payload ->> 'Name')), ''), '(unnamed account)'), 200),
           left(coalesce(nullif(e.payload ->> 'AccountType', ''), 'Unknown'), 64),
           left(nullif(e.payload ->> 'AccountSubType', ''), 64),
           coalesce(e.payload ->> 'AccountType', '') = 'Bank',
           coalesce(v_bank_map ->> e.external_id, case when v_mode = 'file' then coalesce(v_own, 'unmapped') else 'unmapped' end),
           v_bank_map ->> e.external_id,
           (e.payload -> 'Active') is distinct from 'false'::jsonb,
           fin.qbo_money(e.payload -> 'CurrentBalance'),
           false
    from pg_temp.q_eff e
    where e.object_type = 'Account' and e.why is null
    on conflict (connection_id, source_id) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, name = excluded.name,
          type = excluded.type, subtype = excluded.subtype, is_bank = excluded.is_bank, entity_code = excluded.entity_code,
          owner_entity_code = excluded.owner_entity_code, active = excluded.active, current_balance = excluded.current_balance, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.name, t.type, t.subtype, t.is_bank, t.entity_code, t.owner_entity_code, t.active, t.current_balance, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.name, excluded.type, excluded.subtype,
                              excluded.is_bank, excluded.entity_code, excluded.owner_entity_code, excluded.active, excluded.current_balance, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  update fin.accounts t set deleted = true, active = false, name = '(deleted account)', subtype = null, current_balance = null
  from pg_temp.q_eff e
  where e.object_type = 'Account' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('accounts', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb));

  -- ============================================================ invoices
  v_step := 'invoices';
  create temp table pg_temp.q_inv on commit drop as
  select e.raw_id, e.external_id as id, e.source_updated_at, e.payload #>> '{CustomerRef,value}' as cust,
         fin.qbo_date(e.payload ->> 'TxnDate') as issue_date, fin.qbo_date(e.payload ->> 'DueDate') as due_date,
         fin.qbo_money(e.payload -> 'TotalAmt') as total, fin.qbo_money(e.payload -> 'Balance') as balance,
         fin.qbo_doc_classes(e.payload) as classes,
         coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
         coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided
  from pg_temp.q_eff e where e.object_type = 'Invoice' and e.why is null;
  select count(*) into v_invalid from pg_temp.q_inv
  where issue_date is null or total is null or balance is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(classes || array[coalesce(cust, 'x')]);
  with w as (
    insert into fin.invoices as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, customer_id, customer_name,
                                   issue_date, due_date, total, balance, class_id, multi_class, entity_code, currency_code, voided, deleted)
    select p_lane, p_connection_id, i.id, i.raw_id, i.source_updated_at, i.cust, (select c.name from pg_temp.q_cust c where c.id = i.cust),
           i.issue_date, i.due_date, i.total, i.balance,
           case when cardinality(i.classes) = 1 then i.classes[1] end, cardinality(i.classes) > 1,
           fin.qbo_resolve_entity(v_mode, v_own, v_tracking, i.classes, i.cust, v_class_map, v_cust_map),
           i.currency, i.voided, false
    from pg_temp.q_inv i
    where i.issue_date is not null and i.total is not null and i.balance is not null and i.currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(i.classes || array[coalesce(i.cust, 'x')])
    on conflict (connection_id, source_id) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, customer_id = excluded.customer_id,
          customer_name = excluded.customer_name, issue_date = excluded.issue_date, due_date = excluded.due_date,
          total = excluded.total, balance = excluded.balance, class_id = excluded.class_id, multi_class = excluded.multi_class,
          entity_code = excluded.entity_code, currency_code = excluded.currency_code, voided = excluded.voided, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.customer_id, t.customer_name, t.issue_date, t.due_date, t.total, t.balance, t.class_id,
             t.multi_class, t.entity_code, t.currency_code, t.voided, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.customer_id, excluded.customer_name,
                              excluded.issue_date, excluded.due_date, excluded.total, excluded.balance, excluded.class_id,
                              excluded.multi_class, excluded.entity_code, excluded.currency_code, excluded.voided, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  update fin.invoices t set deleted = true, total = 0, balance = 0, customer_id = null, customer_name = null, class_id = null, multi_class = false
  from pg_temp.q_eff e
  where e.object_type = 'Invoice' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('invoices', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb, 'invalid', v_invalid));
  select count(*) filter (where classes is not null and cardinality(classes) > 1), count(*) filter (where currency <> 'USD')
    into v_multi, v_non_usd
  from pg_temp.q_inv where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(cust, 'x')]);
  v_counts := v_counts || jsonb_build_object('multi_class_invoices', v_multi, 'non_usd_invoices', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_inv where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(cust, 'x')]);
  end if;

  -- ============================================================ bills
  v_step := 'bills';
  create temp table pg_temp.q_bill on commit drop as
  select e.raw_id, e.external_id as id, e.source_updated_at, e.payload #>> '{VendorRef,value}' as vend,
         fin.qbo_date(e.payload ->> 'TxnDate') as issue_date, fin.qbo_date(e.payload ->> 'DueDate') as due_date,
         fin.qbo_money(e.payload -> 'TotalAmt') as total, fin.qbo_money(e.payload -> 'Balance') as balance,
         fin.qbo_doc_classes(e.payload) as classes,
         coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
         coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided
  from pg_temp.q_eff e where e.object_type = 'Bill' and e.why is null;
  select count(*) into v_invalid from pg_temp.q_bill
  where issue_date is null or total is null or balance is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(classes || array[coalesce(vend, 'x')]);
  with w as (
    insert into fin.bills as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, vendor_id, vendor_name,
                                issue_date, due_date, total, balance, class_id, multi_class, entity_code, currency_code, voided, deleted)
    select p_lane, p_connection_id, b.id, b.raw_id, b.source_updated_at, b.vend, (select c.name from pg_temp.q_vend c where c.id = b.vend),
           b.issue_date, b.due_date, b.total, b.balance,
           case when cardinality(b.classes) = 1 then b.classes[1] end, cardinality(b.classes) > 1,
           fin.qbo_resolve_entity(v_mode, v_own, v_tracking, b.classes, null, v_class_map, v_cust_map),
           b.currency, b.voided, false
    from pg_temp.q_bill b
    where b.issue_date is not null and b.total is not null and b.balance is not null and b.currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(b.classes || array[coalesce(b.vend, 'x')])
    on conflict (connection_id, source_id) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, vendor_id = excluded.vendor_id,
          vendor_name = excluded.vendor_name, issue_date = excluded.issue_date, due_date = excluded.due_date,
          total = excluded.total, balance = excluded.balance, class_id = excluded.class_id, multi_class = excluded.multi_class,
          entity_code = excluded.entity_code, currency_code = excluded.currency_code, voided = excluded.voided, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.vendor_id, t.vendor_name, t.issue_date, t.due_date, t.total, t.balance, t.class_id,
             t.multi_class, t.entity_code, t.currency_code, t.voided, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.vendor_id, excluded.vendor_name,
                              excluded.issue_date, excluded.due_date, excluded.total, excluded.balance, excluded.class_id,
                              excluded.multi_class, excluded.entity_code, excluded.currency_code, excluded.voided, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  update fin.bills t set deleted = true, total = 0, balance = 0, vendor_id = null, vendor_name = null, class_id = null, multi_class = false
  from pg_temp.q_eff e
  where e.object_type = 'Bill' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('bills', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb, 'invalid', v_invalid));
  select count(*) filter (where classes is not null and cardinality(classes) > 1), count(*) filter (where currency <> 'USD')
    into v_multi, v_non_usd
  from pg_temp.q_bill where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(vend, 'x')]);
  v_counts := v_counts || jsonb_build_object('multi_class_bills', v_multi, 'non_usd_bills', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_bill where issue_date is not null and total is not null and balance is not null and currency ~ '^[A-Z]{3}$' and fin.qbo_ids_ok(classes || array[coalesce(vend, 'x')]);
  end if;

  v_step := 'payments';
  -- ============================================================ payments (invoices are loaded; unknown invoices stay unapplied)
  create temp table pg_temp.q_pay on commit drop as
  select e.raw_id, e.external_id as id, e.source_updated_at, e.payload,
         fin.qbo_date(e.payload ->> 'TxnDate') as txn_date, fin.qbo_money(e.payload -> 'TotalAmt') as total,
         fin.qbo_money(e.payload -> 'UnappliedAmt') as unapplied, e.payload #>> '{CustomerRef,value}' as cust,
         coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
         coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided,
         null::text as ent
  from pg_temp.q_eff e where e.object_type = 'Payment' and e.why is null;
  select count(*) into v_invalid from pg_temp.q_pay where txn_date is null or total is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(cust, 'x')]);
  delete from pg_temp.q_pay where txn_date is null or total is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(cust, 'x')]);

  -- One row per allocation to an invoice, in line order. invoice_id: null when the invoice is not in fin (not in raw yet, or
  -- skipped as invalid: unapplied, linked later in place) or is voided (link refused). A dead invoice never gets here: the payment is dead ('linked').
  create temp table pg_temp.q_alloc on commit drop as
  select l.pay_id, (row_number() over (partition by l.pay_id order by l.n))::integer - 1 as alloc_no, l.amount, l.inv_src,
         (fi.id is null) as unknown,
         (ie.external_id is not null and (coalesce((ie.payload -> 'Voided') = 'true'::jsonb, false)
                                          or coalesce(fi.voided, false) or coalesce(fi.deleted, false))) as refused,
         fi.id as fin_invoice_id, fi.entity_code as inv_entity
  from (
    select p.id as pay_id, x.n, fin.qbo_money(x.line -> 'Amount') as amount,
           (select lt ->> 'TxnId' from jsonb_array_elements(case when jsonb_typeof(x.line -> 'LinkedTxn') = 'array' then x.line -> 'LinkedTxn' else '[]'::jsonb end) lt
            where lt ->> 'TxnType' = 'Invoice' limit 1) as inv_src
    from pg_temp.q_pay p
    cross join lateral jsonb_array_elements(case when jsonb_typeof(p.payload -> 'Line') = 'array' then p.payload -> 'Line' else '[]'::jsonb end) with ordinality x(line, n)
  ) l
  left join pg_temp.q_eff ie on ie.object_type = 'Invoice' and ie.external_id = l.inv_src
  left join fin.invoices fi on fi.connection_id = p_connection_id and fi.source_id = l.inv_src
  where l.inv_src is not null and l.amount is not null;

  update pg_temp.q_pay p set ent = coalesce(
    (select case when count(distinct a.inv_entity) = 1 then min(a.inv_entity) end from pg_temp.q_alloc a
     where a.pay_id = p.id and a.inv_entity is not null and not a.unknown and not a.refused),
    fin.qbo_resolve_entity(v_mode, v_own, v_tracking, '{}'::text[], p.cust, v_class_map, v_cust_map))
  -- T-242: an explicit top-level predicate. PostgREST sessions (the authenticator role) preload pg-safeupdate, which refuses an
  -- UPDATE or DELETE without a WHERE clause with SQLSTATE 21000; the WHERE inside the subquery above does not count. Every payment
  -- row has an id, so this keeps all rows.
  where p.id is not null;

  create temp table pg_temp.q_prow on commit drop as
  select a.pay_id, a.alloc_no, a.amount,
         case when a.unknown or a.refused then null else a.fin_invoice_id end as invoice_id,
         case when a.unknown or a.refused then null else a.inv_entity end as ent
  from pg_temp.q_alloc a
  union all
  select p.id, n.c, case when n.c = 0 then p.total else p.unapplied end, null::uuid, null::text
  from pg_temp.q_pay p
  cross join lateral (select count(*)::integer as c from pg_temp.q_alloc a where a.pay_id = p.id) n
  where n.c = 0 or coalesce(p.unapplied, 0) > 0;

  -- T-242: one row per (payment, allocation) is what the upsert needs (by construction it is; a duplicate would be a bug). Checked
  -- with a hash aggregate (cheap) and refused with 21000 under its own step, never silently dropped (rule 7: no lost money rows).
  v_step := 'payment_keys';
  if exists (select 1 from pg_temp.q_prow group by pay_id, alloc_no having count(*) > 1) then
    raise exception 'duplicate payment allocation key' using errcode = '21000';
  end if;
  v_step := 'payments';
  -- Reallocation log (ids only): an existing allocation row whose invoice link changes or is removed.
  create temp table pg_temp.q_realloc on commit drop as
  select f.id as payment_row, f.invoice_id as from_invoice, r.invoice_id as to_invoice, row_number() over (order by f.id) as rn
  from pg_temp.q_prow r
  join fin.payments f on f.connection_id = p_connection_id and f.source_id = r.pay_id and f.alloc_no = r.alloc_no
  where f.invoice_id is not null and f.invoice_id is distinct from r.invoice_id and not f.deleted;
  select count(*), coalesce(jsonb_agg(jsonb_build_object('payment_row', payment_row, 'from_invoice', from_invoice, 'to_invoice', to_invoice) order by rn) filter (where rn <= 200), '[]'::jsonb)
    into v_realloc_n, v_realloc
  from pg_temp.q_realloc;
  select count(*) filter (where a.refused), count(*) filter (where a.unknown) into v_refused_voided, v_unknown_invoice from pg_temp.q_alloc a;

  with w as (
    insert into fin.payments as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, invoice_id, paid_at, amount,
                                   entity_code, voided, deleted, currency_code, alloc_no, customer_name)
    select p_lane, p_connection_id, p.id, p.raw_id, p.source_updated_at, r.invoice_id,
           (p.txn_date::timestamp at time zone 'America/New_York'), r.amount, coalesce(r.ent, p.ent), p.voided, false, p.currency,
           r.alloc_no, (select c.name from pg_temp.q_cust c where c.id = p.cust)
    from pg_temp.q_prow r join pg_temp.q_pay p on p.id = r.pay_id
    on conflict (connection_id, source_id, alloc_no) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, invoice_id = excluded.invoice_id,
          paid_at = excluded.paid_at, amount = excluded.amount, entity_code = excluded.entity_code, voided = excluded.voided,
          currency_code = excluded.currency_code, customer_name = excluded.customer_name, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.invoice_id, t.paid_at, t.amount, t.entity_code, t.voided, t.currency_code, t.customer_name, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.invoice_id, excluded.paid_at, excluded.amount,
                              excluded.entity_code, excluded.voided, excluded.currency_code, excluded.customer_name, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  -- Allocations a payment no longer has.
  update fin.payments t set deleted = true
  where t.connection_id = p_connection_id and not t.deleted
    and exists (select 1 from pg_temp.q_prow r where r.pay_id = t.source_id)
    and not exists (select 1 from pg_temp.q_prow r where r.pay_id = t.source_id and r.alloc_no = t.alloc_no);
  get diagnostics v_stale = row_count;
  update fin.payments t set deleted = true, amount = 0, invoice_id = null, customer_name = null
  from pg_temp.q_eff e
  where e.object_type = 'Payment' and e.why is not null and t.connection_id = p_connection_id and t.source_id = e.external_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('payments', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb,
    'stale_allocations', v_stale, 'invalid', v_invalid, 'unapplied_unknown_invoice', v_unknown_invoice,
    'links_refused_voided_invoice', v_refused_voided, 'reallocated', v_realloc_n));
  select count(*) filter (where p.currency <> 'USD') into v_non_usd from pg_temp.q_prow r join pg_temp.q_pay p on p.id = r.pay_id;
  v_counts := v_counts || jsonb_build_object('non_usd_payments', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_prow;
  end if;

  v_step := 'transactions';
  -- ============================================================ transactions (accounts are loaded)
  create temp table pg_temp.q_txn on commit drop as
  with docs as (
    select e.raw_id, e.object_type, e.external_id, e.source_updated_at, e.payload,
           fin.qbo_doc_classes(e.payload) as classes, fin.qbo_date(e.payload ->> 'TxnDate') as txn_date,
           coalesce(e.payload #>> '{CurrencyRef,value}', 'USD') as currency,
           coalesce((e.payload -> 'Voided') = 'true'::jsonb, false) as voided,
           e.object_type = 'Purchase' and coalesce((e.payload -> 'Credit') = 'true'::jsonb, false) as credit,
           case e.object_type
             when 'Payment' then e.payload #>> '{CustomerRef,value}'
             when 'Purchase' then case when e.payload #>> '{EntityRef,type}' = 'Customer' then e.payload #>> '{EntityRef,value}' end
           end as cust
    from pg_temp.q_eff e
    where e.why is null and e.object_type in ('Purchase', 'Deposit', 'JournalEntry', 'Bill', 'BillPayment', 'Payment')
  )
  select d.raw_id, d.object_type as txn_type, d.external_id as source_id, 0 as line_no, d.source_updated_at, d.txn_date, d.currency,
         d.voided, d.cust, d.classes as eclasses, case when cardinality(d.classes) = 1 then d.classes[1] end as class_id,
         h.acct, h.amount
  from docs d
  cross join lateral (select
    case d.object_type
      when 'Purchase' then d.payload #>> '{AccountRef,value}'
      when 'Deposit' then d.payload #>> '{DepositToAccountRef,value}'
      when 'Payment' then d.payload #>> '{DepositToAccountRef,value}'
      when 'BillPayment' then coalesce(d.payload #>> '{CheckPayment,BankAccountRef,value}', d.payload #>> '{CreditCardPayment,CCAccountRef,value}')
      when 'Bill' then d.payload #>> '{APAccountRef,value}'
    end as acct,
    fin.qbo_money(d.payload -> 'TotalAmt') * case when d.object_type in ('Purchase', 'BillPayment', 'Bill') then -1 else 1 end
      * case when d.credit then -1 else 1 end as amount) h
  where d.object_type <> 'JournalEntry' and h.acct is not null
  union all
  select d.raw_id, d.object_type, d.external_id, l.n::integer, d.source_updated_at, d.txn_date, d.currency, d.voided, d.cust,
         case when c.lc is null then '{}'::text[] else array[c.lc] end, c.lc, x.acct, fin.qbo_money(l.line -> 'Amount') * x.sign * case when d.credit then -1 else 1 end
  from docs d
  cross join lateral jsonb_array_elements(case when jsonb_typeof(d.payload -> 'Line') = 'array' then d.payload -> 'Line' else '[]'::jsonb end) with ordinality l(line, n)
  cross join lateral (select coalesce(fin.qbo_line_class(l.line), d.payload #>> '{ClassRef,value}') as lc) c
  cross join lateral (select
    case
      when d.object_type in ('Purchase', 'Bill') and (l.line -> 'AccountBasedExpenseLineDetail') is not null then l.line #>> '{AccountBasedExpenseLineDetail,AccountRef,value}'
      when d.object_type = 'Deposit' then l.line #>> '{DepositLineDetail,AccountRef,value}'
      when d.object_type = 'JournalEntry' then l.line #>> '{JournalEntryLineDetail,AccountRef,value}'
    end as acct,
    case
      when d.object_type in ('Purchase', 'Bill') and ((l.line -> 'AccountBasedExpenseLineDetail') is not null or (l.line -> 'ItemBasedExpenseLineDetail') is not null) then 1
      when d.object_type = 'Deposit' and (l.line -> 'DepositLineDetail') is not null then -1
      when d.object_type = 'JournalEntry' and l.line #>> '{JournalEntryLineDetail,PostingType}' = 'Debit' then 1
      when d.object_type = 'JournalEntry' and l.line #>> '{JournalEntryLineDetail,PostingType}' = 'Credit' then -1
    end as sign) x
  where x.sign is not null;
  select count(*) into v_invalid from pg_temp.q_txn where txn_date is null or amount is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(class_id, 'x'), coalesce(cust, 'x')]);
  delete from pg_temp.q_txn where txn_date is null or amount is null or currency !~ '^[A-Z]{3}$' or not fin.qbo_ids_ok(array[coalesce(class_id, 'x'), coalesce(cust, 'x')]);
  -- T-242: one row per (txn_type, source_id, line_no), as the upsert needs (by construction; checked, refused under its own step).
  v_step := 'transaction_keys';
  if exists (select 1 from pg_temp.q_txn group by txn_type, source_id, line_no having count(*) > 1) then
    raise exception 'duplicate posting line key' using errcode = '21000';
  end if;
  v_step := 'transactions';

  -- A BillPayment takes the entity of the live bill(s) it pays when they agree (like a payment takes its invoice's), else unmapped.
  create temp table pg_temp.q_bpent on commit drop as
  select e.external_id as id,
         (select case when count(distinct b.entity_code) = 1 then min(b.entity_code) end
          from jsonb_array_elements(case when jsonb_typeof(e.payload -> 'Line') = 'array' then e.payload -> 'Line' else '[]'::jsonb end) l
          cross join lateral jsonb_array_elements(case when jsonb_typeof(l -> 'LinkedTxn') = 'array' then l -> 'LinkedTxn' else '[]'::jsonb end) lt
          join fin.bills b on b.connection_id = p_connection_id and b.source_id = lt ->> 'TxnId' and not b.deleted and not b.voided
          where lt ->> 'TxnType' = 'Bill') as ent
  from pg_temp.q_eff e where e.object_type = 'BillPayment' and e.why is null;

  with w as (
    insert into fin.transactions as t (lane_id, connection_id, source_id, raw_record_id, source_updated_at, txn_type, line_no, txn_date,
                                       posted_at, account_id, class_id, entity_code, amount, is_uncategorized, voided, deleted, currency_code)
    select p_lane, p_connection_id, q.source_id, q.raw_id, q.source_updated_at, q.txn_type, q.line_no, q.txn_date,
           (q.txn_date::timestamp at time zone 'America/New_York'), a.id, q.class_id,
           case when q.txn_type = 'Payment'
                then coalesce(pe.ent, fin.qbo_resolve_entity(v_mode, v_own, v_tracking, '{}'::text[], q.cust, v_class_map, v_cust_map))
                when q.txn_type = 'BillPayment' then coalesce(bp.ent, 'unmapped')
                else fin.qbo_resolve_entity(v_mode, v_own, v_tracking, q.eclasses, q.cust, v_class_map, v_cust_map) end,
           q.amount, coalesce(a.name ~* '^(uncategorized|ask my accountant)', false), q.voided, false, q.currency
    from pg_temp.q_txn q
    left join fin.accounts a on a.connection_id = p_connection_id and a.source_id = q.acct and not a.deleted
    left join pg_temp.q_pay pe on q.txn_type = 'Payment' and pe.id = q.source_id
    left join pg_temp.q_bpent bp on q.txn_type = 'BillPayment' and bp.id = q.source_id
    on conflict (connection_id, txn_type, source_id, line_no) do update
      set raw_record_id = excluded.raw_record_id, source_updated_at = excluded.source_updated_at, txn_date = excluded.txn_date,
          posted_at = excluded.posted_at, account_id = excluded.account_id, class_id = excluded.class_id,
          entity_code = excluded.entity_code, amount = excluded.amount, is_uncategorized = excluded.is_uncategorized,
          voided = excluded.voided, currency_code = excluded.currency_code, deleted = false
      where (t.raw_record_id, t.source_updated_at, t.txn_date, t.posted_at, t.account_id, t.class_id, t.entity_code, t.amount,
             t.is_uncategorized, t.voided, t.currency_code, t.deleted)
            is distinct from (excluded.raw_record_id, excluded.source_updated_at, excluded.txn_date, excluded.posted_at, excluded.account_id,
                              excluded.class_id, excluded.entity_code, excluded.amount, excluded.is_uncategorized, excluded.voided,
                              excluded.currency_code, false)
    returning (xmax = 0) as ins)
  select count(*) filter (where ins), count(*) filter (where not ins) into v_ins, v_upd from w;
  -- Lines a live document no longer has.
  update fin.transactions t set deleted = true
  where t.connection_id = p_connection_id and not t.deleted
    and exists (select 1 from pg_temp.q_eff e where e.why is null and e.object_type = t.txn_type and e.external_id = t.source_id
                and fin.qbo_date(e.payload ->> 'TxnDate') is not null)
    and not exists (select 1 from pg_temp.q_txn q where q.txn_type = t.txn_type and q.source_id = t.source_id and q.line_no = t.line_no);
  get diagnostics v_stale = row_count;
  update fin.transactions t set deleted = true, amount = 0, account_id = null, class_id = null, is_uncategorized = false
  from pg_temp.q_eff e
  where e.why is not null and e.object_type = t.txn_type and e.external_id = t.source_id
    and t.connection_id = p_connection_id and not t.deleted;
  get diagnostics v_tomb = row_count;
  v_counts := v_counts || jsonb_build_object('transactions', jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'tombstoned', v_tomb,
    'stale_lines', v_stale, 'invalid', v_invalid));
  select count(*) filter (where currency <> 'USD') into v_non_usd from pg_temp.q_txn;
  v_counts := v_counts || jsonb_build_object('non_usd_transactions', v_non_usd);
  if v_fallback then
    select v_fallback_rows + count(*) into v_fallback_rows from pg_temp.q_txn;
  end if;

  v_step := 'summary';
  select (select count(*) from fin.invoices where connection_id = p_connection_id and entity_code = 'unmapped' and not voided and not deleted)
       + (select count(*) from fin.bills where connection_id = p_connection_id and entity_code = 'unmapped' and not voided and not deleted)
       + (select count(*) from fin.transactions where connection_id = p_connection_id and entity_code = 'unmapped' and not voided and not deleted)
    into v_unmapped;
  select count(*) into v_null_account from fin.transactions
  where connection_id = p_connection_id and account_id is null and not voided and not deleted and line_no > 0;
  v_counts := v_counts || jsonb_build_object('unmapped_rows', v_unmapped, 'class_fallback_rows', v_fallback_rows,
    'null_account_lines', v_null_account,
    'invalid_records', coalesce((v_counts -> 'invoices' ->> 'invalid')::integer, 0) + coalesce((v_counts -> 'bills' ->> 'invalid')::integer, 0)
                     + coalesce((v_counts -> 'payments' ->> 'invalid')::integer, 0) + coalesce((v_counts -> 'transactions' ->> 'invalid')::integer, 0));

  drop table pg_temp.q_payroll, pg_temp.q_eff, pg_temp.q_cust, pg_temp.q_vend, pg_temp.q_inv, pg_temp.q_bill,
    pg_temp.q_pay, pg_temp.q_alloc, pg_temp.q_prow, pg_temp.q_txn, pg_temp.q_bpent, pg_temp.q_realloc;

  insert into fin.normalize_runs (lane_id, connection_id, mapping_mode, class_tracking, class_fallback, unseen_cutoff, counts,
                                  reallocation_count, reallocations, started_at, finished_at)
  values (p_lane, p_connection_id, v_mode, v_tracking, v_fallback, v_cutoff, v_counts, v_realloc_n, v_realloc, v_started, clock_timestamp());
  return v_counts || jsonb_build_object('class_tracking', v_tracking, 'class_fallback', v_fallback);
  exception when others then
    get stacked diagnostics v_err_table = table_name, v_err_constraint = constraint_name;
    raise exception 'fin.qbo_normalize failed: SQLSTATE %, table %, constraint %, step %', sqlstate, coalesce(nullif(v_err_table, ''), '-'), coalesce(nullif(v_err_constraint, ''), '-'), v_step
      using errcode = sqlstate;
  end;
end;
$$;

comment on function core.fin_qbo_normalize(text, uuid) is
  'Normalizes one QuickBooks connection''s raw.source_records into fin.* (T-056; T-243: stores Account.CurrentBalance; T-242: the error names the step, built keys checked, every UPDATE/DELETE has a WHERE for pg-safeupdate). Idempotent, lane-checked, never deletes, tombstones deleted/unseen/excluded records, tags entities from lane_config. Service_role only.';
revoke all on function core.fin_qbo_normalize(text, uuid) from public, anon, authenticated;
grant execute on function core.fin_qbo_normalize(text, uuid) to service_role;

-- T-243 review: the context also returns the ids of the lane's QuickBooks connections that are not disconnected, so Cash reads only their accounts
-- (a sandbox connection that was replaced by the real one keeps its fin.accounts rows). The return type changes: drop and create.
drop function if exists core.home_finance_context(text);
create function core.home_finance_context(p_lane text)
returns table (
  allowed boolean,
  connected boolean,
  connection_status text,
  last_sync_at timestamptz,
  last_normalized_at timestamptz,
  own_entity text,
  mapping_mode text,
  bank_accounts jsonb,
  qbo_connections uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb;
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or not (p_lane = any (core.allowed_lanes(auth.uid(), 'finance'))) then
    return query select false, false, null::text, null::timestamptz, null::timestamptz, null::text, null::text, '[]'::jsonb, '{}'::uuid[];
    return;
  end if;
  select cc.config into v_cfg from core.lane_config_current cc where cc.lane_id = p_lane;
  return query
  select
    true,
    exists (select 1 from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'),
    (select k.status from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'
       order by (k.status = 'active') desc, k.created_at desc limit 1),
    (select max(k.last_sync_at) from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'),
    -- T-243 re-check L-2: only runs of the current (not disconnected) QuickBooks connections; a replaced connection's run is not "as of".
    (select max(r.finished_at) from fin.normalize_runs r
      where r.lane_id = p_lane
        and r.connection_id in (select k.id from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected')),
    case when jsonb_typeof(v_cfg #> '{entities,own_entity}') = 'string' then v_cfg #>> '{entities,own_entity}' end,
    case when jsonb_typeof(v_cfg #> '{qbo,entity_mapping_mode}') = 'string' then v_cfg #>> '{qbo,entity_mapping_mode}' end,
    case when jsonb_typeof(v_cfg #> '{entities,bank_accounts}') = 'array' then v_cfg #> '{entities,bank_accounts}' else '[]'::jsonb end,
    coalesce((select array_agg(k.id) from core.connections k where k.lane_id = p_lane and k.provider = 'quickbooks' and k.status <> 'disconnected'), '{}'::uuid[]);
end;
$$;
comment on function core.home_finance_context(text) is
  'Home finance (T-233): QuickBooks connection facts, last normalizer run and entity/bank mapping for a caller who holds the finance view at AAL2. Definer only to read those; allowed = false for anyone else.';
revoke all on function core.home_finance_context(text) from public, anon;
grant execute on function core.home_finance_context(text) to authenticated, service_role;

create or replace function core.home_finance(p_lane text)
returns table (
  state text,
  as_of timestamptz,
  last_sync_at timestamptz,
  connection_status text,
  business_date date,
  cash_reason text,
  cash_total numeric(18,2),
  cash_as_of timestamptz,
  cash_accounts jsonb,
  cash_unmapped integer,
  ar_reason text,
  ar_over_30 numeric(18,2),
  ar_invoices integer,
  ar_unmapped integer,
  pnl_reason text,
  pnl_income numeric(18,2),
  pnl_expenses numeric(18,2),
  pnl_net numeric(18,2),
  pnl_start date,
  pnl_end date,
  pnl_method text,
  pnl_partial boolean,
  pnl_as_of timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c record;
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_month_start date := pg_catalog.date_trunc('month', (pg_catalog.now() at time zone 'America/New_York'))::date;
  v_state text;
  v_as_of timestamptz;
  v_has_data boolean;
  rep record;
  v_cash_reason text; v_cash_total numeric(18,2); v_cash_as_of timestamptz; v_cash_accounts jsonb := '[]'; v_cash_unmapped integer := 0;
  v_banks_n integer;
  v_ar_reason text; v_ar_sum numeric(18,2); v_ar_n integer; v_ar_unmapped integer; v_inv_any boolean;
  v_pnl_reason text; v_inc numeric(18,2); v_exp numeric(18,2); v_pstart date; v_pend date; v_pmethod text; v_ppartial boolean; v_pas timestamptz;
  v_data_rows integer;
  v_rows jsonb;
  v_pnl_re constant text := '^-?[0-9]{1,16}(\.[0-9]{1,6})?$';
begin
  if p_lane is null then
    raise exception 'lane is required' using errcode = '22004';
  end if;
  select * into c from core.home_finance_context(p_lane);
  if not coalesce(c.allowed, false) then
    return query select 'no_access'::text, null::timestamptz, null::timestamptz, null::text, v_today,
      null::text, null::numeric, null::timestamptz, '[]'::jsonb, 0,
      null::text, null::numeric, 0, 0,
      null::text, null::numeric, null::numeric, null::numeric, null::date, null::date, null::text, false, null::timestamptz;
    return;
  end if;

  v_as_of := coalesce(c.last_normalized_at, c.last_sync_at);
  v_has_data := c.last_normalized_at is not null
    or exists (select 1 from fin.invoices i where i.lane_id = p_lane)
    or exists (select 1 from fin.report_cache r where r.lane_id = p_lane);
  v_state := case
    when not c.connected then 'not_connected'
    when c.own_entity is null then 'mapping_missing'
    when not v_has_data then 'no_data'
    else 'ok' end;

  if v_state <> 'ok' then
    return query select v_state, v_as_of, c.last_sync_at, c.connection_status, v_today,
      null::text, null::numeric, null::timestamptz, '[]'::jsonb, 0,
      null::text, null::numeric, 0, 0,
      null::text, null::numeric, null::numeric, null::numeric, null::date, null::date, null::text, false, null::timestamptz;
    return;
  end if;

  -- ------------------------------------------------------------ cash (book balance)
  -- T-243: the sum of the current balances (QuickBooks Account.CurrentBalance, kept by the normalizer in fin.accounts) of the
  -- lane's active bank accounts, as of the last books sync. The balance sheet is not read.
  if jsonb_array_length(c.bank_accounts) = 0 then
    v_cash_reason := 'bank_mapping_missing';
  else
    -- The least of the two: a balance is only as fresh as the older of the last sync and the last normalize that stored it.
    v_cash_as_of := least(coalesce(c.last_sync_at, c.last_normalized_at), coalesce(c.last_normalized_at, c.last_sync_at));
    with bank as (
      select a.source_id as acct_id, a.name as acct_name, a.current_balance as bal, a.entity_code
      from fin.accounts a
      where a.lane_id = p_lane and a.is_bank and a.active and not a.deleted and a.connection_id = any (c.qbo_connections)
    ), mapped as (
      select b.*,
        (select count(distinct m.j ->> 'owner_entity') from jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id) as owners,
        exists (select 1 from jsonb_array_elements(c.bank_accounts) m(j) where m.j ->> 'qbo_account_id' = b.acct_id and m.j ->> 'owner_entity' = c.own_entity) as own,
        (b.entity_code <> c.own_entity) as elsewhere
      from bank b
    )
    select
      coalesce(pg_catalog.sum(x.bal) filter (where x.own), 0),
      coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', x.acct_name, 'book_balance', x.bal,
        'shared', (x.owners > 1 or x.elsewhere)) order by x.acct_name, x.acct_id) filter (where x.own), '[]'::jsonb),
      (pg_catalog.count(*) filter (where x.owners = 0))::integer,
      (pg_catalog.count(*) filter (where x.own))::integer
    into v_cash_total, v_cash_accounts, v_cash_unmapped, v_banks_n
    from mapped x;
    if v_banks_n = 0 then
      v_cash_reason := 'no_own_bank_accounts';
    elsif exists (select 1 from jsonb_array_elements(v_cash_accounts) a(j) where a.j ->> 'book_balance' is null) then
      v_cash_reason := 'balance_unreadable';
    end if;
  end if;

  -- ------------------------------------------------------------ AR over 30 days
  select exists (select 1 from fin.invoices i where i.lane_id = p_lane and not i.voided and not i.deleted) into v_inv_any;
  if not v_inv_any then
    v_ar_reason := 'no_invoices';
  else
    select coalesce(pg_catalog.sum(i.balance) filter (where i.entity_code = c.own_entity), 0),
           (pg_catalog.count(*) filter (where i.entity_code = c.own_entity))::integer,
           (pg_catalog.count(*) filter (where i.entity_code = 'unmapped'))::integer
    into v_ar_sum, v_ar_n, v_ar_unmapped
    from fin.invoices i
    where i.lane_id = p_lane and not i.voided and not i.deleted and i.balance > 0 and i.currency_code = 'USD'
      and coalesce(i.due_date, i.issue_date) < v_today - 30;
  end if;

  -- ------------------------------------------------------------ P&L month to date
  select r.* into rep from fin.report_cache r
  where r.lane_id = p_lane and r.report = 'pnl'
    and r.params ->> 'start_date' = pg_catalog.to_char(v_month_start, 'YYYY-MM-DD')
    and r.params ->> 'end_date' >= pg_catalog.to_char(v_month_start, 'YYYY-MM-DD')
    and r.params ->> 'end_date' <= pg_catalog.to_char(v_month_start + interval '1 month' - interval '1 day', 'YYYY-MM-DD')
  order by r.as_of desc, r.fetched_at desc limit 1;
  if not found then
    v_pnl_reason := 'month_report_not_cached';
  elsif c.mapping_mode = 'file_class' and not (rep.params ? 'class') then
    v_pnl_reason := 'report_not_split_by_class';
  elsif coalesce(rep.payload #>> '{Header,SummarizeColumnsBy}', 'Total') <> 'Total' then
    v_pnl_reason := 'report_has_columns';
  else
    v_rows := case when jsonb_typeof(rep.payload #> '{Rows,Row}') = 'array' then rep.payload #> '{Rows,Row}' else '[]'::jsonb end;
    select
      pg_catalog.sum(x.amt) filter (where x.grp in ('Income', 'OtherIncome')),
      pg_catalog.sum(x.amt) filter (where x.grp in ('COGS', 'Expenses', 'OtherExpenses')),
      pg_catalog.count(*)::integer,
      (pg_catalog.count(*) filter (where x.amt is null))::integer
    into v_inc, v_exp, v_data_rows, v_banks_n
    from (
      select e.j ->> 'group' as grp,
             case when (e.j #>> '{ColData,1,value}') ~ v_pnl_re
                  then pg_catalog.round((e.j #>> '{ColData,1,value}')::numeric, 2) end as amt
      from jsonb_array_elements(v_rows) e(j)
      where e.j ->> 'type' = 'Data' and (e.j ->> 'group') in ('Income', 'OtherIncome', 'COGS', 'Expenses', 'OtherExpenses')
    ) x;
    if v_data_rows = 0 then
      v_pnl_reason := 'report_empty';
    elsif v_banks_n > 0 then
      v_pnl_reason := 'figure_unreadable';
    else
      v_inc := coalesce(v_inc, 0);
      v_exp := coalesce(v_exp, 0);
      v_pstart := (rep.params ->> 'start_date')::date;
      v_pend := (rep.params ->> 'end_date')::date;
      v_pmethod := rep.params ->> 'method';
      v_ppartial := coalesce(rep.payload #>> '{Header,TotalsWithheld}', 'false') = 'true';
      v_pas := rep.as_of;
    end if;
  end if;

  return query select 'ok'::text, v_as_of, c.last_sync_at, c.connection_status, v_today,
    v_cash_reason, case when v_cash_reason is null then v_cash_total end, case when v_cash_reason is null then v_cash_as_of end,
    case when v_cash_reason is null then v_cash_accounts else '[]'::jsonb end, v_cash_unmapped,
    v_ar_reason, case when v_ar_reason is null then v_ar_sum end, case when v_ar_reason is null then v_ar_n else 0 end,
    case when v_ar_reason is null then v_ar_unmapped else 0 end,
    v_pnl_reason, case when v_pnl_reason is null then v_inc end, case when v_pnl_reason is null then v_exp end,
    case when v_pnl_reason is null then v_inc - v_exp end,
    case when v_pnl_reason is null then v_pstart end, case when v_pnl_reason is null then v_pend end,
    case when v_pnl_reason is null then v_pmethod end, coalesce(v_ppartial, false), case when v_pnl_reason is null then v_pas end;
end;
$$;
comment on function core.home_finance(text) is
  'Home finance (T-233, T-243): cash book balance (own entity bank accounts from fin.accounts current balances, D-18), AR over 30 days, P&L month to date, each with a reason when absent. Figures from fin.* only. Invoker: RLS applies.';
revoke all on function core.home_finance(text) from public, anon;
grant execute on function core.home_finance(text) to authenticated, service_role;
