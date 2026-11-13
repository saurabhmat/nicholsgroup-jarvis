-- T-197 review fix: the Settings page reads which QuickBooks disconnects are waiting for approval WITHOUT writing and WITHOUT the
-- 100-row cap of core.act_list. Invoker function: RLS on act.proposed_actions decides what the caller sees (owner and
-- admin_technical of the lane at AAL2). It returns only ids (the proposal and its connection): no payload, no target, no hash.
create or replace function core.act_pending_qbo_disconnects(p_lane text) returns table (id uuid, connection_id uuid)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.connection_id from act.proposed_actions a
  where a.lane_id = p_lane and a.action_type = 'qbo.disconnect' and a.status = 'proposed' and a.expires_at > pg_catalog.now();
$$;
comment on function core.act_pending_qbo_disconnects(text) is 'Settings (T-197): ids of the lane''s unexpired pending qbo.disconnect proposals; invoker, RLS applies; read-only, no row cap.';
revoke all on function core.act_pending_qbo_disconnects(text) from public, anon, authenticated, service_role;
grant execute on function core.act_pending_qbo_disconnects(text) to authenticated;
