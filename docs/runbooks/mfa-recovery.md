# Runbook: two-factor recovery (lost or replaced phone)

Every user signs in with an emailed code and then a code from an authenticator app (D-6, T-019). If the authenticator
is lost, an admin removes the user's factor so they can enrol a new one. Agents never perform these steps.

**Who:** Saurabh (admin_technical) performs the reset; Robert (owner) is told. For Saurabh's own account, Robert
approves and a second person with Supabase dashboard access performs it.

## 1. Verify the person

Confirm the request by a channel other than email: call the person back on a number **already on file** (never one
given in the request), or meet in person. Email alone is not enough: anyone with access to the mailbox could request
a reset and then enrol their own authenticator. Stay on the call until step 4 is done.

## 2. Remove the factor

Supabase dashboard (production project) → Authentication → Users → the user → **Multi-Factor Authentication** →
delete the TOTP factor(s). Then end every session of that user in the SQL editor:

```sql
delete from auth.sessions where user_id = '<affected user id>';      -- refresh tokens go with their sessions
select count(*) from auth.refresh_tokens where user_id = '<affected user id>'::text and not revoked;  -- expect 0
```

Then allow exactly one new authenticator (a stolen session cannot add one by itself, T-020):

```sql
insert into core.mfa_enrolment_state (user_id, enrolled_at, reset_allowed_at, reset_allowed_by)
values ('<affected user id>', now(), now(), '<admin user id>')
on conflict (user_id) do update set reset_allowed_at = now(), reset_allowed_by = '<admin user id>';
```

The allowance is used up when the new authenticator's first code is accepted.

## 3. Record it in the audit log

SQL editor (production project), as the service role:

```sql
select audit.log(
  'PKG',                                  -- the user's primary lane
  'user', '<admin user id>',              -- who performed the reset
  'mfa.factor_reset',
  'user:<affected user id>',
  '{"reason": "lost_device", "verified_by": "phone_call"}'
);
```

## 4. The user enrols again

While still on the call, the user signs in with the email code and sets up the authenticator on the two-factor
page. Confirm the new factor in the dashboard (its created time is "just now") and that Supabase sent the "factor
added" email. Ask them to remove the old entry from any authenticator app they still have. If a factor appears that
the user did not add, remove it and repeat from step 1 with the mailbox secured.

## Notes

- After step 2, existing access tokens stop working within 15 minutes at the latest (access token lifetime, H-026);
  refresh is impossible immediately.
- Five wrong authenticator codes within 15 minutes lock verification for 15 minutes (`mfa.lockout` in the audit log).
  Repeated lockouts for one user are a sign of an attack on that account: check the mailbox and sessions.
- If the person's mailbox may be compromised as well, do not re-enable access until the mailbox is secured.
