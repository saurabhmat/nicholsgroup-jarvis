# Spec — Finance (M3 Business Performance)

Status: proposed (planner output, T-075). Owner: Saurabh. Users: Robert (owner), Sophie (finance_operator), Saurabh (admin_technical, no content).
Refines backlog T-055 – T-060, T-080 – T-097. Read `CLAUDE.md`, `docs/pilot-scope.md` and `docs/plan-review.md` §7 (D-2, D-9) first.

## 1. Purpose

Give Robert and Sophie one trustworthy view of Pub K Group (PKG) finance: cash (book balance), AR/AP, P&L, subscription revenue (MRR and churn from Stripe), paid subscribers (GoHighLevel) and a controls panel. Every figure is computed by SQL over synced source data, carries its source and `as_of`, and ties out to QuickBooks reports and Sophie's weekly cash report for two consecutive weeks (success criterion 1).

## 2. Scope

In scope (Release A, PKG only, built multi-lane):
- Normalised finance tables, metric views and functions, immutable snapshots with sign-off.
- Query layer used by the UI and the AI tools (the only read path).
- Jobs: sync, QBO reports, weekly cash (Sat–Fri), monthly close, daily controls.
- Dashboard, detail pages, weekly report + sign-off, tie-out pages.

Out of scope:
- Any write to QuickBooks, Stripe or GoHighLevel (rule 5, rule 13). Distribution of the weekly report is an email proposal handled by `docs/specs/approvals.md`.
- Plaid / live bank balances; Nichols Law, TimeSolv, intercompany, consolidated owner view (other lanes, later, by configuration).
- Revenue from GoHighLevel (never; rule 8). Payroll, compensation, trust ledgers, account or routing numbers (never stored).
- AI-written figures. The assistant reads figures through `packages/modules/finance` tools (see `assistant.md`).

## 3. Non-negotiables applied here

- Every function, view, job and tool takes `laneId` (`p_lane_id` in SQL). DB clients come from the lane router. All company settings are read from `lane_config`; no PKG ids in code.
- Money `numeric(18,2)`; time `timestamptz`; months and weeks computed in America/New_York; business week Sat–Fri.
- Cash is always labelled "book balance" (column `book_balance`, API field `bookBalance`, UI label "Book balance"). Never "bank balance".
- Stripe is the source of revenue and MRR. GoHighLevel is the source of subscriber status and has no money columns. The two are never added together; a mismatch is a control flag, not a merge.
- Only the finance normalisers and snapshot jobs write `fin.*` (service role, jobs only). AI output and the browser never write `fin.*`.
- Metric views are `security_invoker = true` and filter `lane_id`; functions take `p_lane_id` and are `security invoker` unless they are the sign-off functions (below).

## 4. Metric definitions (authoritative)

### 4.1 Pilot KPI list (D-2, recorded Oct 24, 2026)

| KPI id (`lane_config.kpis`) | Definition | Source |
|---|---|---|
| `cash_book_balance` | Book balance per bank-type account, shown in full under the legally owning entity (D-18). Never allocated, never labelled "bank balance". | QBO |
| `ar_total`, `ar_over_30` | Open invoice balance; AR over 30 = balance more than 30 days past due (buckets 31–60, 61–90, 90+). | QBO |
| `ap_due_14d` | Open bill balance with due date on or before today + 14 days (ET date); overdue bills included and shown as a sub-line. | QBO |
| `pnl_mtd`, `pnl_ytd` | P&L for the month-to-date and year-to-date, accounting method from `lane_config`. | QBO |
| `mrr` | See 4.2. | Stripe |
| `revenue_churn_pct` | See 4.2. | Stripe |
| `customer_churn_pct` | See 4.3. Hidden as "Pending definition (D-3)" until D-3 is decided. | GoHighLevel |
| `paid_subscribers`, `subscribers_new_week`, `subscribers_cancelled_week` | Count of GoHighLevel paid subscribers (rule from D-3) and the business-week new/cancelled counts. | GoHighLevel |
| `controls_*` | Unreconciled items >30 days, disconnected feeds, uncategorised transactions (plus the extra controls in 4.5). | QBO + core |

The KPI list per lane lives in `lane_config.kpis` (T-011). D-2's "Monthly churn" is delivered as the two figures above.

### 4.2 MRR and revenue churn (D-9, Stripe)

Month = calendar month in America/New_York. **Start of month = 00:00 America/New_York on the 1st** (decided Oct 24, 2026). The month-end instant is the start of the next month, so one month's end MRR equals the next month's start MRR. November 2026 is a 721-hour month (DST ends Nov 1 at 02:00), and 00:00 on Nov 1 is still EDT; both are test cases.

- **MRR** = sum of active Stripe subscriptions, normalised to monthly (annual ÷ 12, quarterly ÷ 3), after recurring coupons. Excludes trials, 100%-discounted subscriptions and one-off charges. PKG products only, via `lane_config`.
  - Normalisation, per subscription item: `unit_amount × quantity` converted by price interval: month ÷ `interval_count`; year ÷ 12 ÷ `interval_count`; week × 52 ÷ 12 ÷ `interval_count`; day × 365 ÷ 12 ÷ `interval_count`. Half-cent results round at the end of the sum (banker's rounding is not used; `round(x, 2)`).
  - Recurring coupons: a `percent_off` or `amount_off` coupon with duration `forever`, or `repeating` and not yet expired at the instant, reduces MRR. `amount_off` is normalised like a price and capped so MRR is not negative. `once` coupons are ignored. The discount is applied to the subscription's PKG items pro rata.
  - Excluded: status `trialing`, items on non-PKG products (by entity mapping), metered/usage prices (flagged in controls), non-USD subscriptions (flagged), tax, shipping, one-off invoice items.
  - A subscription is **active** when its status is `active` or `past_due`; `canceled`, `unpaid`, `paused`, `incomplete`, `incomplete_expired` and `trialing` are not active. A subscription whose MRR is 0 because of a 100% discount is active but contributes 0 (and is not "churned").
- **Churned MRR** = MRR of subscriptions cancelled or ended in the month (effective end, not a scheduled `cancel_at_period_end`).
- **Revenue churn %** = churned MRR ÷ MRR at the start of the month. Null when start MRR is 0.
- **Net new MRR** = new + expansion − contraction − churned. Invariant tested on every fixture and as a property test: `end_mrr = start_mrr + net_new_mrr`.

Month movement classification, per subscription and entity, comparing the snapshot at the start instant (`ts0`) with the snapshot at the end instant (`ts1`):

| Situation | Movement |
|---|---|
| Active at `ts0` and at `ts1` (including 0 → >0 or >0 → 0 through coupons) | Expansion if MRR rose, contraction if it fell, by `mrr(ts1) − mrr(ts0)`. Price, quantity or coupon changes only count through this month-start vs month-end comparison (decided Oct 24, 2026). |
| Active with MRR >0 at `ts0`, not active at `ts1` | Churned = `mrr(ts0)`. |
| Not active at `ts0`, active at `ts1` with MRR >0 (new subscription, trial converted, resumed) | New = `mrr(ts1)`. |
| Not active at `ts0` and not active at `ts1`, but active with MRR >0 at some point inside the month | **Counts as both new and churned** (decided Oct 24, 2026), each equal to the MRR at first activation. |
| Anything else | No movement. |

Intra-month changes that never appear at a month boundary are ignored by design, which is what makes the invariant hold. A customer who cancels one subscription and starts another in the same month shows as churned plus new. The current month is "month to date": end instant = now, flagged `is_final = false` until the month closes and its snapshot is signed.

### 4.3 Subscribers and customer churn (GoHighLevel)

- **Paid subscriber** = a GoHighLevel contact meeting the lane's rule in `lane_config` (tag / pipeline stage / product, combinable), evaluated by T-060. The rule itself is open decision **D-3**. APK/PKI tags and products are excluded (D-17).
- **Customer churn %** = subscribers cancelled in the month ÷ subscribers active at the start of the month. Subscribers come from **GoHighLevel**, not Stripe (decided Oct 24, 2026, so this KPI **waits on D-3**). Same-month start + cancel counts as new **and** cancelled, as in 4.2. Start instant as in 4.2.
- Weekly counts (`new`, `cancelled`, `trial_to_paid`, `failed_payment`) use the business week `fin.business_week` (Sat 00:00 – Fri 23:59:59 ET).
- GoHighLevel never contributes an amount. The Stripe-vs-GoHighLevel difference in active customer count is shown only in the controls panel.

### 4.4 Cash, AR/AP, P&L

- Cash: latest QBO book balance per bank-type account from the Balance Sheet report cache (`as_of` of the report), shown under the owner entity from `lane_config` bank-account mapping (D-18). A bank account mapped to an entity that is not the account's actual owner is shown as is; no allocation. Shared accounts are flagged in controls.
- AR/AP: split by QBO class (D-18), else by customer/vendor mapping in `lane_config`. If the Reports API cannot filter aging by class (open, plan-review §3), aging is computed from class-tagged `fin.invoices` / `fin.bills` and tied to a class-filtered report Sophie runs in QBO.
- P&L MTD/YTD: from `fin.report_cache` (class-filtered), `as_of` and accounting method shown. Entity split as above.
- Stripe revenue by product (month, net of refunds) is a separate view from MRR and is the only revenue figure besides MRR. Payouts are shown at account level and never split by entity (D-18).

### 4.5 Controls panel

Each control returns `{code, status: ok|warn|red, value, threshold, detailRefs[], asOf}`. Thresholds come from `lane_config.controls` (defaults in brackets).
1. `unreconciled_over_30d`: bank accounts whose last reconciliation is older than 30 days (default 30). QBO's API does not expose reconciliation state reliably, so the source is `fin.reconciliation_status` entered by Sophie (audited), until T-051/T-052 prove otherwise.
2. `disconnected_feeds`: connectors (QBO, Stripe, GHL) in error or without a successful sync for more than N hours (default 36), from `core.connections` / `core.sync_runs`. Bank-feed health inside QBO is not available through the API.
3. `uncategorized_transactions`: count and sum of transactions posted to QBO "Uncategorized …" accounts in the open period.
4. `stripe_vs_ghl_count_mismatch`: distinct Stripe customers with an active PKG subscription vs GoHighLevel paid subscribers; flag when the difference exceeds the lane threshold. No merging.
5. `shared_bank_account`: a bank account used by more than one entity (D-18).
6. `period_lock`: books closed-through date vs expected.
7. `unmapped_entity`: rows (invoices, bills, transactions, Stripe items, GHL contacts) that resolve to no entity in the mapping.
8. `unsupported_billing`: metered or non-USD Stripe items excluded from MRR.
Red flags emit a `finance.red_flag` notification event (T-161) with template text and lane code only.

## 5. Data model

All tables: `lane_id text not null references core.lanes`, RLS on, AAL2 required, policy `lane_id = any(core.allowed_lanes(auth.uid(), 'finance'))`. Read roles: owner, finance_operator, and viewers with the named `finance` view. `admin_technical` has no finance content view; it sees sync health only. No `authenticated` insert/update/delete on any `fin.*` table; writers are the service role in jobs (`getLaneJobClient(laneId)`) and the sign-off functions below. Every table has pgTAP RLS tests including cross-lane denial and AAL1 denial (T-013 catalog test enforces this).

Entity: every row that can belong to an entity has `entity_code text` set by the normaliser from the `lane_config` mapping (`'PKG'`, `'APK'`, `'PKI'`, or `'unmapped'`). PKG views filter `entity_code = <the lane's own entity>`; they do not hide other entities' rows from the controls.

### Part 1 — ledger and reports (T-055, T-056)

| Table | Key columns |
|---|---|
| `fin.accounts` | `id`, `lane_id`, `source_id` (QBO Id), `name`, `type`, `subtype`, `is_bank`, `entity_code`, `owner_entity_code` (from bank-account mapping), `active`. No account or routing numbers (field allowlist test). |
| `fin.transactions` | `id`, `lane_id`, `source_id`, `txn_type`, `txn_date date`, `posted_at timestamptz`, `account_id`, `class_id`, `entity_code`, `amount numeric(18,2)`, `is_uncategorized`, `voided`, source refs. |
| `fin.invoices` | `source_id`, `customer_id`, `issue_date`, `due_date`, `total`, `balance numeric(18,2)`, `class_id`, `entity_code`, `voided`. |
| `fin.payments` | `source_id`, `invoice_id`, `paid_at`, `amount`, `entity_code`. |
| `fin.bills` | `source_id`, `vendor_id`, `issue_date`, `due_date`, `total`, `balance`, `class_id`, `entity_code`, `voided`. |
| `fin.report_cache` | `report` (`pnl`, `balance_sheet`, `cash_flow`, `ar_aging_summary`, …), `params jsonb` (range, method, class), `params_hash`, `payload jsonb`, `as_of timestamptz`, `fetched_at`. Unique `(lane_id, report, params_hash, as_of)`. |
| `fin.reconciliation_status` (new, T-191) | `account_id`, `last_reconciled_on date`, `entered_by`, `entered_at`, `note`. Insert-only (history); latest wins; entries audited. Written by a security-definer function restricted to finance_operator and owner. |

`fin.accounts.book_balance` is not stored on the account; the cash view reads the Balance Sheet cache (and cross-checks against the transactions ledger in tests).

### Part 2 — subscriptions (T-057, T-190, T-058, T-060)

| Table | Key columns |
|---|---|
| `fin.stripe_subscriptions` | Current state: `source_id`, `customer_id`, `status`, `currency`, `livemode`, `start_date`, `canceled_at`, `ended_at`, `cancel_at_period_end`, `trial_end`, `entity_code` (null = mixed, see items), `created`, `event_version`. |
| `fin.stripe_subscription_items` | `subscription_id`, `item_id`, `price_id`, `product_id`, `entity_code`, `interval`, `interval_count`, `unit_amount numeric(18,2)`, `quantity`, `usage_type`, `currency`. |
| `fin.stripe_discounts` | `subscription_id`, `coupon_id`, `percent_off numeric`, `amount_off numeric(18,2)`, `duration` (`forever|repeating|once`), `duration_in_months`, `starts_at`, `ends_at`. |
| `fin.stripe_subscription_versions` (T-190) | **History used for point-in-time MRR.** Grain: subscription × entity. `subscription_id`, `entity_code`, `valid_from timestamptz`, `valid_to timestamptz null`, `status`, `is_active bool`, `mrr numeric(18,2)` (after recurring coupons, normalised), `product_ids text[]`, `cause` (event id). A version is closed and a new one opened on each change of status, items, quantity, price, coupon or coupon expiry. Exclusion constraint: no overlapping ranges per subscription and entity. Rebuilt idempotently from `raw.source_records` events; backfilled from the subscription's current state plus Stripe events (`events` list only reaches back 30 days, so the initial backfill derives start state from `created`, `start_date` and invoice line history; documented in T-190). |
| `fin.stripe_invoices`, `fin.stripe_charges`, `fin.stripe_refunds`, `fin.stripe_payouts` | Revenue and payout facts, `numeric(18,2)`, `created timestamptz`, `product_id` per invoice line, `entity_code`. Payouts have no entity (account level). |
| `fin.subscriber_status` (T-060) | Current state per GHL contact: `contact_id`, `product_key`, `entity_code`, `is_paid`, `since`, `trial`, `last_event_at`. **No revenue or amount columns** (pgTAP column check). |
| `fin.subscriber_events` (T-060) | Append-only history: `contact_id`, `product_key`, `entity_code`, `event` (`new|cancelled|trial_to_paid|failed_payment`), `occurred_at timestamptz`, `rule_version`. Point-in-time membership and customer churn are reconstructed from this table. |

Test vs live: Stripe rows carry `livemode`; views filter to the value in `lane_config.stripe.livemode` (staging uses test mode).

### Part 3 — snapshots, tie-out (T-089, T-094)

| Table | Key columns |
|---|---|
| `fin.snapshots` | `id`, `lane_id`, `kind` (`weekly|monthly`), `period_start`, `period_end` (`timestamptz`), `version int`, `payload jsonb` (figures + source refs + `as_of` per figure + definitions version), `payload_sha256`, `generated_at`, `generated_by` (job or user), `restates_snapshot_id`. **Insert-only for every role** (trigger blocks update, delete, truncate). Unique `(lane_id, kind, period_start, version)`. |
| `fin.snapshot_signoffs` | `snapshot_id`, `lane_id`, `signed_by`, `signed_at`, `role`, `payload_sha256_seen`, `note`. Insert-only, unique per snapshot. Created only by `fin.sign_off_snapshot(p_lane_id, p_snapshot_id, p_hash_seen)`: security definer, requires AAL2 with a recent TOTP (step-up), role finance_operator or owner on the lane, and `p_hash_seen` = stored hash. Audited. |
| `fin.tieout_reference` | Manual reference figures from Sophie's report: `period_start`, `kpi`, `entity_code`, `value numeric(18,2)`, `entered_by`, `entered_at`, `source_note`. Insert-only (corrections are new rows); audited. |

Snapshot figures are never edited. A correction after sign-off is a new version with `restates_snapshot_id`, which needs its own sign-off. The weekly report of week W is generated Friday and signed by Sophie or Robert; unsigned snapshots are marked "Draft" everywhere.

### Business calendar functions (T-080)

`fin.business_week(ts timestamptz) returns (week_start timestamptz, week_end timestamptz)`, week_end exclusive (next Saturday 00:00 ET); `fin.month_start(ts)`, `fin.next_month_start(ts)`, `fin.ytd_start(ts)`, `fin.et_date(ts)`; all `immutable` where possible, with the zone fixed to `America/New_York`.

## 6. SQL views and functions

All take `p_lane_id`; views are `security_invoker`, include `lane_id` and are queried only with `lane_id = $1` by the query layer. The db-engineer implements; the shapes below are the contract.

- `fin.v_cash_book_balance` → `(lane_id, owner_entity_code, account_id, account_name, book_balance, as_of)`. Every account in full under its legally owning entity.
- `fin.v_ar_aging` → `(lane_id, entity_code, bucket, balance, invoice_count, as_of)`; buckets `current, 1_30, 31_60, 61_90, 90_plus`; `fin.ar_over_30(p_lane_id, p_entity)` sums 31+.
- `fin.v_ap_aging`, `fin.v_ap_due_14d` → `(lane_id, entity_code, due_14d_total, overdue_total, bill_count, as_of)` using `fin.et_date(now()) + 14`.
- `fin.pnl(p_lane_id, p_entity, p_from, p_to)` over the report cache; `fin.v_pnl_mtd`, `fin.v_pnl_ytd`.
- `fin.mrr_at(p_lane_id, p_entity, p_ts)` → `numeric(18,2)`; `fin.subscription_state_at(p_lane_id, p_entity, p_ts)` → `(subscription_id, is_active, mrr)` from `fin.stripe_subscription_versions where valid_from <= p_ts and (valid_to is null or valid_to > p_ts)`.
- `fin.mrr_movements(p_lane_id, p_entity, p_month date)` → `(month_start, is_final, start_mrr, new_mrr, expansion_mrr, contraction_mrr, churned_mrr, end_mrr, net_new_mrr, revenue_churn_pct)`, implemented as in this sketch:

```sql
with b as (select fin.month_start(p_month) ts0, fin.next_month_start(p_month) ts1),
s0 as (select * from fin.subscription_state_at(p_lane_id, p_entity, (select ts0 from b))),
s1 as (select * from fin.subscription_state_at(p_lane_id, p_entity, (select ts1 from b))),
mid as ( -- active with mrr>0 at any version inside the month
  select subscription_id, (array_agg(mrr order by valid_from))[1] as first_mrr
  from fin.stripe_subscription_versions v, b
  where v.lane_id = p_lane_id and v.entity_code = p_entity and v.is_active and v.mrr > 0
    and v.valid_from < b.ts1 and (v.valid_to is null or v.valid_to > b.ts0)
  group by 1)
select ... case
  when coalesce(s0.is_active,false) and coalesce(s1.is_active,false) then delta -> expansion/contraction
  when coalesce(s0.is_active,false) and s0.mrr>0 and not coalesce(s1.is_active,false) then churned = s0.mrr
  when not coalesce(s0.is_active,false) and coalesce(s1.is_active,false) and s1.mrr>0 then new = s1.mrr
  when not coalesce(s0.is_active,false) and not coalesce(s1.is_active,false) and mid.first_mrr is not null
       then new = churned = mid.first_mrr
end
```
  For the current month `ts1` is `least(next_month_start, now())` and `is_final = false`.
- `fin.v_mrr_monthly` → one row per month since `lane_config.metrics.start_month`, using `fin.mrr_movements`.
- `fin.subscriber_state_at(p_lane_id, p_entity, p_ts)` from `fin.subscriber_events` (and the lane's `rule_version`); `fin.subscriber_movements(p_lane_id, p_entity, p_month)` → `(start_count, new_count, cancelled_count, end_count, customer_churn_pct, is_final, status)` where `status = 'pending_definition'` while the lane has no `paid_subscriber_rule`. Subscribers are counted per distinct contact (see open question Q-F4).
- `fin.v_subscribers_week` → `(week_start, product_key, new, cancelled, trial_to_paid, failed_payment, active_end)`; no money columns (pgTAP).
- `fin.v_stripe_revenue_month` → `(month_start, product_id, entity_code, gross, refunds, net)`; `fin.v_stripe_payouts` account level.
- `fin.v_controls` → rows per 4.5. `fin.v_tieout(p_lane_id, p_week)` → `(kpi, entity_code, portal_value, qbo_value, reference_value, diff_portal_qbo, diff_portal_ref, within_tolerance)`; tolerance from `lane_config.tieout.tolerance` (default 0.00).

Required SQL tests: movements invariant, DST months (Mar, Nov 2026), year boundary, `business_week` (Fri 23:59:59 vs Sat 00:00 ET), tie to fixture reports, `security_invoker` behaviour (a non-member gets zero rows), no money columns on subscriber views, no `book`/`bank` mislabel (column-name check).

## 7. Query layer (T-081)

`packages/modules/finance/domain`, lane-scoped, the only path used by UI and AI tools:

```ts
type FinanceResult<T> = {
  laneId: LaneId;
  figures: T;                         // numbers as strings with 2 decimals, plus display strings
  sources: SourceRef[];               // { kind: 'qbo_report'|'stripe'|'ghl'|'fin_view', ref, asOf }
  asOf: string;                       // min as_of of the sources used
  freshness: 'live' | 'cached' | 'stale';   // thresholds in lane_config
  status: 'ok' | 'pending_definition' | 'no_data';
  notes: string[];                    // e.g. "book balance", "month to date, not final"
};
getCashBookBalance(ctx, laneId, opts)   getArAging(ctx, laneId, opts)   getApAging(...)   getPnl(...)
getMrr(ctx, laneId, month)              getSubscribers(ctx, laneId, week)   getControls(ctx, laneId)
getTieOut(ctx, laneId, week)            getSnapshot(ctx, laneId, id)
```
Every function calls `requireLane` / `requireRole`, takes its client from `getLaneClient`, validates input with Zod, and returns display strings produced server-side (so the assistant can quote them verbatim). Any `"use cache"` use includes `laneId` and the role in the key.

## 8. Connector calls

Only through `packages/connectors/*`, read-only (`read`/`sync`; no `prepareWrite` for finance):
- QuickBooks: CDC for Account, Customer, Vendor, Invoice, Payment, Bill, BillPayment, Purchase, Deposit, JournalEntry, Class; Reports API (P&L, Balance Sheet, Cash Flow, AR/AP aging summary and detail) with date range, accounting method, class from `lane_config` (T-051, T-052).
- Stripe: customers, products, prices, subscriptions, invoices, charges, refunds, payouts, balance transactions, plus webhooks (T-054, T-058).
- GoHighLevel: contacts, tags, pipelines/opportunities, products, orders/subscriptions (T-059).
Normalisers read `raw.source_records` only, never call providers.

## 9. Jobs (Inngest; each takes `laneId`, per-connection concurrency key)

| Job | Trigger | Behaviour |
|---|---|---|
| `fin.sync` | schedule per enabled lane from `lane_config`, plus webhook events | run connector syncs, normalise, rebuild `fin.stripe_subscription_versions` incrementally; idempotent; `core.sync_runs` rows. |
| `fin.qbo_reports` | schedule (default 2×/day) + before weekly cash | fetch reports into `fin.report_cache`. |
| `fin.weekly_cash` | cron Friday, time from `lane_config.finance.weekly_cash_time` (default 18:00 ET, `TZ=America/New_York`) | ensure fresh reports, build the Sat–Fri snapshot (cash by account as book balance at week end and start, Stripe payouts in the week at account level, AR/AP totals, AR >30, AP due 14d, subscribers new/cancelled for the week, controls summary), store PDF/CSV in private per-lane Storage (derived figures only), notify Sophie "report ready to sign off". Distribution only via an email proposal (D-14 open). |
| `fin.monthly_close` | `lane_config.finance.monthly_close_trigger` (`day_of_month:N` or `manual`) | final-month snapshot incl. MRR movements and subscriber movements, `is_final = true`. |
| `fin.controls_daily` | daily | evaluate controls; emit red-flag events. |

Failures are logged in `core.sync_runs`, alert admin_technical, and never produce partial snapshots (a snapshot is written in one transaction after all sources are fresher than the staleness threshold; otherwise the job writes nothing and notifies).

## 10. UI (App Router; navigation per D-15 once approved)

- `/finance` dashboard: KPI cards from `lane_config.kpis`, each with source chip, freshness badge and "as of". Cash cards read "Book balance". Customer churn card reads "Pending definition (D-3)" while `status = 'pending_definition'`. MTD figures labelled "month to date".
- `/finance/cash`, `/finance/ar-ap` (TanStack Table, bucket drill-down), `/finance/pnl`, `/finance/subscriptions` (Recharts: MRR waterfall new/expansion/contraction/churned, subscribers by week), `/finance/controls`.
- `/finance/reports`: weekly and monthly snapshots; detail shows payload, hash, sign-off state; "Sign off" requires step-up (T-020) and shows the hash being signed.
- `/finance/tie-out`: portal vs QBO vs reference per KPI per week, pass/fail; "Enter reference figure" form (finance_operator, owner), audited.
- All data via the query layer; Playwright: AAL1 user redirected, viewer without `finance` view denied, label "Book balance" present.

## 11. Edge cases

- Refunds and credit notes affect revenue, not MRR. Voided QBO records excluded; deleted QBO records handled by CDC.
- Stripe events arrive out of order: versions are rebuilt by `created`/event version, not arrival time.
- Subscription schedules: a future phase becomes a version at its start time. Multi-item subscriptions that span entities produce one version row per entity.
- QBO backdated edits in a closed period: flagged by `period_lock`; signed snapshots are not changed (restatement versions).
- Stale source: figures show "stale" and the weekly job refuses to snapshot.
- Negative book balance shown as is. Foreign currency is excluded and flagged.
- Staging uses sandboxes: `livemode` filter prevents test data in live figures.

## 12. Acceptance tests (Given / When / Then)

1. Given a lane with an annual $1,200 price, a quarterly $300 price and a monthly $100 price all active at month start, when `fin.mrr_at` runs, then MRR = 100 + 100 + 100.
2. Given a 25% `forever` coupon and a `once` coupon on different subscriptions, then MRR reflects only the forever coupon.
3. Given a trialing subscription and a 100%-discounted active subscription, then neither adds MRR and the 100% one does not count as churned when it cancels.
4. Given a subscription active at Nov 1 00:00 EDT with MRR 100 that upgrades to 150 on Nov 12, when movements for November run, then expansion = 50, and the invariant holds.
5. Given a subscription that starts Nov 5 at 100 and cancels Nov 20, then new = 100 and churned = 100 for November; revenue churn % numerator includes it, denominator does not.
6. Given start MRR 1,000 and churned 50, then revenue churn % = 5.00; with start MRR 0 it is null.
7. Given GHL events with contact A subscribed Oct 20 and cancelled Nov 3, contact B subscribed and cancelled inside November, and contact C subscribed Nov 10, when November movements run, then start_count = 1, new_count = 2 (B, C), cancelled_count = 2 (A, B), end_count = 1 and customer churn % = 200.00 (cancelled ÷ start, not clamped; same-month start + cancel counts as both). Given no `paid_subscriber_rule` in `lane_config`, then status = `pending_definition` and the dashboard card shows the pending label.
8. Given Friday 23:59:59 ET and Saturday 00:00:00 ET, then they fall in different business weeks, across a DST change week as well.
9. Given a bank account mapped to the Pub K Institute entity, then it appears under that entity in full and in none of the PKG totals; a shared account raises the `shared_bank_account` control.
10. Given an APK-class invoice, then it appears in no PKG AR figure and in `unmapped_entity` only if its class is unmapped.
11. Given a signed snapshot, when any role (including service) updates or deletes it, then the statement fails; a restatement creates version 2 with `restates_snapshot_id`.
12. Given a wrong `p_hash_seen`, or an AAL1 session, or a viewer, when sign-off is called, then it is denied and audited.
13. Given a user of another lane, when they query any `fin.*` table or view, then zero rows are returned (cross-lane denial for every table and view).
14. Given the subscriber views, then no column has a money type or a name matching amount/revenue/price (pgTAP column check).
15. Given a stale QBO sync, when `fin.weekly_cash` runs, then no snapshot is written and a notification event is emitted.
16. Given the synthetic Balance Sheet fixture, then the cash view matches to the cent, and the label/column is `book_balance`.
17. Given an assistant tool call, then figures equal query-layer output exactly (see `assistant.md`).

## 13. Open questions

Still-open decisions (designed around, not decided here):
- **D-3** GoHighLevel "paid subscriber" definition. Blocks customer churn %, paid-subscriber counts, and T-060. The rule is a `lane_config` value; the subscriber views return `pending_definition` until it exists.
- **D-8** Sophie's mapping values (QBO class and customer IDs, Stripe product IDs, GHL tags/products, bank-account owners). Needed before tie-out and before any entity-split figure is trusted; fixtures use synthetic ids.
- **D-14** Weekly cash report distribution (email via approvals vs in-portal only). Until decided the report is in-portal with PDF/CSV export; the email proposal step is optional.
- **D-15** Design sign-off for navigation. Pages above use the provisional shell.
- D-1, D-12, D-13 do not affect finance.

New questions for Robert/Saurabh/Sophie (defaults stated; none block building):
- Q-F1 P&L and aging accounting method (accrual vs cash). Default accrual, as `lane_config.finance.accounting_method`.
- Q-F2 Does `past_due` count as active for MRR and customer counts (default yes) and should `paused` count as churn (default yes, resume = new)?
- Q-F3 AP due ≤14 days: include overdue bills (default yes, shown as a sub-line)?
- Q-F4 GoHighLevel subscribers counted per distinct contact (default) or per contact × product? Interacts with D-3.
- Q-F5 Reconciliation status source: the QBO API may not expose it, so the default is Sophie entering the last-reconciled date per bank account (T-191). Confirm T-051/T-052 findings.
- Q-F6 Format of Sophie's weekly cash report, to define the tie-out reference fields and the weekly payload layout (known gap in plan-review §3).
- Q-F7 Historic data: GoHighLevel and Stripe history before the first sync (backfill depth) for the start-of-month snapshot of the first tie-out months.
- Q-F8 Non-USD or metered Stripe prices: confirmed none in PKG?

## 14. Sub-tasks and backlog changes

Refined: T-057, T-060, T-080, T-081, T-082 – T-089, T-091, T-092, T-094, T-095, T-097 (acceptance edits in `docs/backlog.md`).
New (all `status: proposed`): **T-190** Stripe subscription versions (MRR history) builder + backfill; **T-191** Reconciliation status table and entry function. Customer churn % moves from T-086 to T-087 (GoHighLevel source).
