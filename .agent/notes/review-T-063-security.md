# T-063 security review: findings and resolution

| # | Sev | Finding | Resolution |
|---|---|---|---|
| H1 | HIGH | ReDoS in `mime.ts` (lazy backreference regex on HTML, uncapped part size) | `htmlToText` strips comments and script/style/head/title blocks in one `indexOf` pass (an unclosed block drops the rest); tags removed with `<[^<>]*>`; each part is cut before conversion to min(maxChars*4, 1,000,000) chars; total decoded bytes across parts capped at 2 MB. Tests: 1 MB of `<a`, `<head `, `<script `, `<!--`, `&#x`, `<style>` converts in < 1 s. |
| M1 | MED | Header parsing on unbounded input (`headers.ts`) | Raw caps: To/Cc 16 KB, From and Subject 2 KB, one mailbox 2 KB; comment removal `\([^()]*\)`; linear list splitting. Tests: 100 KB of `(`, `<`, `"` parse in < 1 s. |
| M2 | MED | Mailbox allowlist checked only at connect | `guard()` re-reads `lane_config.mailboxes` on every sync, readBody and search; not listed (or empty list) = `forbidden` before any token read or request. Test. |
| M3 | MED | First load not bounded by lane policy | Window = min(`fullSyncDays`, `core.lane_policies.retention_days`) read at sync time via `LaneConfigReader.retentionDays`; unreadable/invalid = error before any Gmail request. Tests with a 30-day lane and an unreadable policy. |
| L1 | LOW | Caller's connection object used after reload | `guard()` returns the authoritative row, asserting `row.id === conn.id`; all later code uses the row. Test with a mismatching loader. |
| L2 | LOW | Wiring guard regex missed the revoke helper | Helper renamed `revokeGoogleGrant`; regex covers it and `google/revoke`; offender list updated. |
| L3 | LOW | Host allowlist too wide | `GOOGLE_HOSTS` = gmail.googleapis.com, oauth2.googleapis.com (the profile and the token/revoke calls use only these). accounts.google.com is the browser redirect, never called; www.googleapis.com returns with Calendar (T-064). Test. |
| L4 | LOW | SQL accepted malformed upserts | Element validation (object, `message_id` string 1..512, `received_at` string, labels/recipients array or null) raises 22023 before the insert. pgTAP. |
| L5 | LOW | Redirect URI origin | Outside local, `GOOGLE_REDIRECT_URI` must be https AND on the origin of `NEXT_PUBLIC_APP_URL` (missing app origin = fail closed). Env tests. |

Accepted/not changed: none. No BLOCKER or HIGH remains.

## Re-review after fixes (security-reviewer, Nov 5, 2026)
- H1 and M1 verified linear: 16 adversarial HTML patterns up to 4M chars scale linearly; header floods ≤ 9 ms at 100 KB; MIME depth/part/byte budgets hold (30 MB base64 part 43 ms).
- `comms_mail_apply_page` still cannot write another lane's rows or cursor; M2/M3 fail closed before any token read or request; `appOrigin` / `GOOGLE_REDIRECT_URI` expose nothing client-side.
- New MEDIUM (fixed by parent): the compare-and-swap ran only on the last chunk, so a stale run could apply earlier chunks (and revive a deleted row) before failing. Now every chunk is checked against `p_expected_cursor`; pgTAP adds a stale intermediate chunk refused with D0409 and writing nothing (plan 67).
- LOW (logged): the function stores any `p_cursor` without checking the `g1.<connection_id>.` prefix; the caller is service_role only and `parseCursor` treats a foreign cursor as a resync.
- Result: no BLOCKER or HIGH remaining.
