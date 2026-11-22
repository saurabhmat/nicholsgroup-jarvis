-- T-263: the approvals database accepts email actions on a Microsoft connection (docs/specs/microsoft.md §10).
-- Until now act.connection_ok required `features.gmail_compose = true` for EVERY email action, whatever the connection's provider, so an email proposal on a
-- Microsoft connection could never be approved or claimed. Now the permission is the provider's own, and the action's provider must be the connection's:
--   google    -> features.gmail_compose  = true   (unchanged)
--   microsoft -> features.graph_mail_write = true (Mail.ReadWrite and Mail.Send granted at the last connect)
--   anything else -> not ok.
-- Everything else is already provider-generic (T-247: act.propose / act.approve / act.claim_execution resolve the mailbox owner through core.mailbox_ids, which holds
-- google and microsoft connections; the RLS select policy, history and claim rows follow the connection's owner; act.proposed_actions.provider accepts both). The owner
-- rule, the lane checks and the body purge are not touched. act.connection_ok is called by act.approve and act.claim_execution, so both gates change together.
-- Tests: 325_approvals_microsoft_email.test.sql (incl. cross-lane denial and the T-247 owner-only rules for a Microsoft mailbox).

create or replace function act.connection_ok(p_lane text, p_row act.proposed_actions) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from core.connections c
    where c.id = p_row.connection_id and c.lane_id = p_lane
      and case
            when p_row.action_type = 'qbo.disconnect' then
              c.provider = 'quickbooks' and c.status in ('active', 'degraded', 'reconnect_required')
              and p_row.target = pg_catalog.jsonb_build_object('realm_id', c.external_account_id)
            else
              c.status in ('active', 'degraded')
              and c.provider = p_row.provider
              and case c.provider
                    when 'google' then c.features ->> 'gmail_compose' = 'true'
                    when 'microsoft' then c.features ->> 'graph_mail_write' = 'true'
                    else false
                  end
          end);
$$;
revoke all on function act.connection_ok(text, act.proposed_actions) from public, anon, authenticated;
