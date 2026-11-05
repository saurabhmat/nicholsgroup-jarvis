-- D-23 follow-up (review of cc9323c): three fixes to the one-lane-per-account rule. No new table: lane_id, RLS and the
-- policies of core.connections and the privileges of the token functions are unchanged.
--
-- 1. Case-insensitive account key. Mailbox-style ids (Google, Microsoft) differ only by case for the same account, so
--    the key is (provider, lower(external_account_id)). QuickBooks realm ids and Stripe account ids are unaffected.
-- 2. An abandoned `pending` row no longer holds the account. A pending row is made before the token is stored; if the
--    store fails (Vault outage) it would otherwise block the account in every other lane until an approvals-only
--    disconnect exists. The account is held from the moment a connection becomes usable (active, degraded,
--    reconnect_required), so the pending -> active step in core.connection_token_store is where a second lane is
--    refused. Two lanes racing for the same account: the first to store wins, the other is refused.
-- 3. The refusal from core.connection_token_store carries its own SQLSTATE (D0023), raised only for a violation of this
--    index. Any other unique violation inside the function (connection_secrets key, the Vault secret name) keeps 23505,
--    so the connector can tell "account in use" from a real fault.
drop index core.connections_one_lane_per_account;
create unique index connections_one_lane_per_account
  on core.connections (provider, lower(external_account_id))
  where status not in ('disconnected', 'pending');

comment on index core.connections_one_lane_per_account is
  'D-23: one provider account (case-insensitive) is connected to one lane only; disconnected and pending connections do not hold the account.';

create or replace function core.connection_token_store(
  p_lane_id text,
  p_connection_id uuid,
  p_secret text,
  p_expires_at timestamptz,
  p_actor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_constraint text;
begin
  perform core.connection_for_token(p_lane_id, p_connection_id, true);
  perform core.connection_token_check_secret(p_secret);
  select s.vault_secret_id into v_secret_id from core.connection_secrets s where s.connection_id = p_connection_id;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'connection:' || p_connection_id::text, 'Connector credential (T-032)');
    insert into core.connection_secrets (connection_id, lane_id, vault_secret_id) values (p_connection_id, p_lane_id, v_secret_id);
  else
    perform vault.update_secret(v_secret_id, p_secret);
    update core.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
  end if;
  begin
    update core.connections set status = 'active', token_expires_at = p_expires_at where id = p_connection_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'connections_one_lane_per_account' then
      -- Raising aborts the whole function: the Vault secret and the mapping made above are rolled back with it.
      raise exception 'connection token: the provider account is connected to another lane' using errcode = 'D0023';
    end if;
    raise;
  end;
  perform audit.log(p_lane_id, case when p_actor_id is null then 'service' else 'user' end, p_actor_id,
                    'connection.token_stored', 'connection:' || p_connection_id::text, '{}');
end;
$$;

revoke all on function core.connection_token_store(text, uuid, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function core.connection_token_store(text, uuid, text, timestamptz, uuid) to service_role;
