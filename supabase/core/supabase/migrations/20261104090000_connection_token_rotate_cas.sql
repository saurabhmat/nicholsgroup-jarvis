-- T-050: compare-and-swap on token rotation (docs/plan-review.md §6, T-033 code M5).
-- A rotating refresh token must not be lost when two refreshes overlap (refresh-on-401 runs inline on several
-- serverless instances, so a job-level concurrency key alone does not serialise it). The caller names the credential
-- it is replacing by the SHA-256 (hex) of the exact text it read. Under the connection's row lock, a mismatch means
-- another refresh already rotated the credential: the call raises 40001 (serialization_failure), changes nothing, and
-- the loser re-reads the stored credential (the winner's) instead of overwriting it.
-- The hash is not a secret in itself, but it is derived from one: it is never logged or audited.

drop function core.connection_token_rotate(text, uuid, text, timestamptz);

create function core.connection_token_rotate(
  p_lane_id text,
  p_connection_id uuid,
  p_secret text,
  p_expires_at timestamptz,
  p_expected_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_current text;
begin
  if core.connection_for_token(p_lane_id, p_connection_id, true) = 'disconnected' then
    raise exception 'connection token: connection is disconnected' using errcode = '55000';
  end if;
  perform core.connection_token_check_secret(p_secret);
  if p_expected_hash is null or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'connection token: expected hash must be 64 lower-case hex characters' using errcode = '22023';
  end if;
  select s.vault_secret_id into v_secret_id from core.connection_secrets s where s.connection_id = p_connection_id;
  if v_secret_id is null then
    raise exception 'connection token: none stored for connection %', p_connection_id using errcode = 'P0002';
  end if;
  select d.decrypted_secret into v_current from vault.decrypted_secrets d where d.id = v_secret_id;
  if v_current is null
     or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_current, 'UTF8')), 'hex') <> p_expected_hash then
    raise exception 'connection token: the credential changed since it was read' using errcode = '40001';
  end if;
  perform vault.update_secret(v_secret_id, p_secret);
  update core.connection_secrets set rotated_at = now() where connection_id = p_connection_id;
  update core.connections set token_expires_at = p_expires_at where id = p_connection_id;
end;
$$;

revoke all on function core.connection_token_rotate(text, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function core.connection_token_rotate(text, uuid, text, timestamptz, text) to service_role;
