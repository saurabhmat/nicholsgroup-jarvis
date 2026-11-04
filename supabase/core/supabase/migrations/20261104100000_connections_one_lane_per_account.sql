-- D-23 (decided Nov 4, 2026): a provider account (QuickBooks realm, Stripe account, GoHighLevel location, mailbox) is
-- connected to ONE lane at a time, never shared between lanes. The existing unique constraint is per lane
-- (lane_id, provider, external_account_id); this partial unique index spans lanes for every connection that is not
-- disconnected. A disconnected connection keeps its row (history) but frees the account for another lane.
--
-- No new table: lane_id, RLS and the standard lane policy of core.connections are unchanged. The violation (23505) is
-- raised to service_role writers only (the connector's connection store), whose error text is never passed on; the
-- connect flow maps it to a fixed refusal. authenticated cannot insert or read other lanes' rows, so the index leaks
-- nothing across lanes.
create unique index connections_one_lane_per_account
  on core.connections (provider, external_account_id)
  where status <> 'disconnected';

comment on index core.connections_one_lane_per_account is
  'D-23: one provider account is connected to one lane only; disconnected connections do not hold the account.';
