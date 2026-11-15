-- T-247 part 5: any lane member who holds own_mail may start a connect of THEIR OWN Google account (Saurabh, Nov 14, 2026: several
-- Google accounts per user, each connected by the user themselves). Before, only owner and admin_technical could connect anything.
--   * core.oauth_state_create: provider 'google' needs own_mail in the lane (owner, admin_technical, viewer); every other provider
--     (QuickBooks, ...) still needs the owner or admin_technical role. Same aal2 requirement and cap as before.
--   * core.oauth_state_consume: the state's own provider decides the same way (an unknown, expired, foreign or not-permitted state
--     returns the same empty result).
-- The mailbox is owned by whoever signs in: the connector sets connections.owner_user_id to this state's user. Nobody connects a
-- mailbox for someone else. Composio rows follow the same ownership rule in the connector (the toolkit/account bind is unchanged).
-- Tests: 319_mail_ownership.test.sql; 270 and the oauth state tests adjusted.

create or replace function core.oauth_state_create(
  p_lane text,
  p_provider text,
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ok boolean;
begin
  -- (computed in a statement: a CASE with THEN inside an IF condition confuses the plpgsql parser)
  select case
           when p_provider = 'google' then p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))
           else core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical'])
         end into v_ok;
  if v_uid is null or v_ok is not true then
    raise exception 'connect not allowed' using errcode = '42501';
  end if;
  delete from core.oauth_states where expires_at <= now();
  if (select count(*) from core.oauth_states where user_id = v_uid) >= 10 then
    raise exception 'too many connects in progress' using errcode = '54000';
  end if;
  insert into core.oauth_states (lane_id, user_id, provider, state_hash, code_verifier, redirect_uri)
  values (p_lane, v_uid, p_provider, p_state_hash, p_code_verifier, p_redirect_uri);
end;
$$;
comment on function core.oauth_state_create(text, text, text, text, text) is
  'Starts a connect (T-035; T-247): google needs own_mail in the lane (a member connects their OWN account), any other provider owner/admin_technical, at aal2; stores the state hash and PKCE verifier.';
revoke all on function core.oauth_state_create(text, text, text, text, text) from public, anon, service_role;
grant execute on function core.oauth_state_create(text, text, text, text, text) to authenticated;

drop function core.oauth_state_consume(text, text);
create function core.oauth_state_consume(p_lane text, p_state_hash text)
returns table (provider text, code_verifier text, redirect_uri text, toolkit text, account_ref text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return; -- same empty result as an unknown state
  end if;
  return query
    delete from core.oauth_states s
    where s.state_hash = p_state_hash
      and s.lane_id = p_lane
      and s.user_id = v_uid
      and s.expires_at > now()
      and case
            when s.provider = 'google' then p_lane = any (core.allowed_lanes(v_uid, 'own_mail'))
            else core.has_lane_role(v_uid, p_lane, array['owner', 'admin_technical'])
          end
    returning s.provider, s.code_verifier, s.redirect_uri, s.toolkit, s.account_ref;
end;
$$;
comment on function core.oauth_state_consume(text, text) is
  'Finishes a connect (T-035, T-219; T-247): returns and deletes the caller''s own unexpired state for the lane when they may still connect that provider (google: own_mail; others: owner/admin_technical); empty otherwise.';
revoke all on function core.oauth_state_consume(text, text) from public, anon, service_role;
grant execute on function core.oauth_state_consume(text, text) to authenticated;
