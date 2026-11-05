# T-039 security review (independent security-reviewer on b7c50df)

| ID | Finding | Disposition |
|----|---------|-------------|
| H1 | Content-body guard was exact-name and bypassable (description, notes, contentBytes, formattedText, ...); monday/gohighlevel not covered | Fixed: substring match on the normalised key (NFKD fold, lower-case, a-z0-9 only) with a small explicit safe-token list (contentType, contentLength, textColor, messageId, context, ...). monday, gohighlevel, timesolv added as content providers. SQL and TS lists pinned by tests. |
| H2 | No forbidden-data guard (SSN, bank ids, rates, credentials) | Fixed: trigger (authoritative) and TS reject these keys for every provider at any depth, fail closed when too deep, no echo. Connectors must strip these fields before storing. |
| M1 | Constraint errors (23514/23502) can put the payload in Postgres logs via DETAIL | Fixed: upsert validates every element first and raises its own errors without DETAIL. |
| M2 | TS had no per-record or per-byte limit, coarse error mapping | Fixed: 1 MB per record, batches cut at 500 records / ~5 MB, SQLSTATE 22/23/54000 map to invalid_input. |
| M4 | Connection status and lane enabled not checked | Fixed: status in (active, degraded) and lane enabled, same 42501 error. |
| L1 | Stored bodies persist after policy flips to false | Deferred: register raw.source_records in the T-042 purge. |
| L5 | No ordering guard on conflict update | Fixed (see code review). |
| - | monday/gohighlevel adapters should still reduce to metadata | Deferred to the adapter tasks. |
| - | Cross-script look-alike keys (Cyrillic o in "body") not folded | Accepted: documented; adapters project to metadata. |

## Round 2 (security-reviewer on 173484c)

| ID | Finding | Disposition |
|----|---------|-------------|
| H-1 | Forbidden-data guard matched exact names only (BankAcctNum, hourlyRate, employeeSsn, id_token ... passed) | Fixed: word-aware rules in SQL and TS (whole words, contained text, `*token` words except sync/page tokens, `rate` adjacency, bare `rate` for timesolv); cases for every reported key in pgTAP and Vitest; classname, pinned, SyncToken, nextPageToken pass. Residual: all-caps run-together names. |
| M-A | note/memo/transcript/preview/excerpt/caption not body names | Fixed (SQL, TS, tests). Denylist-is-a-backstop and allowlist-per-adapter requirement recorded in docs/plan-review.md. |
| M-B | Safe tokens missing for link and mailbox counter fields | Fixed: htmllink, webcontentlink, messagestotal, messagesunread, lastmessagetype, lastmessagedate. Open decision on monday column_values / Notion plain_text logged in docs/plan-review.md. |
| M-C | Walker cost (15 strpos per key, two walks, guards twice on conflict update) | Fixed: single walk, one normalisation per key, one combined regex, 20000 distinct-key cap (22023), skip on unchanged update, 57014 mapped to invalid_input; 5000-key and cap tests. ON CONFLICT with a changed payload still scans twice (documented). |
| L-1 | TS size limit vs jsonb text; NUL in strings | Fixed: 680000 bytes of JSON; U+0000 refused as invalid_input. |
| L-2 | Special timestamp strings; null source_updated_at overwrote | Fixed: ISO-8601 with offset and isfinite; null incoming skipped when stored value is non-null. |
| L-3 | No shared strip helper | Added `stripForbidden()` (key paths only). |

## Round 3 (security-reviewer on 3d839ee)

| ID | Finding | Disposition |
|----|---------|-------------|
| HIGH-1 | `([A-Z]+)([A-Z][a-z])` split was quadratic (80k-char key = 7.5 s) and ran before the size check | Fixed: linear lookahead split `([A-Z])(?=[A-Z](?:[a-rt-z]\|s[a-z]))` in TS and SQL; keys over 256 characters (code points) fail closed (`invalid_input` in TS, 22023 in SQL) before any normalisation; store runs size, then NUL/key-length, then the guards. Timing tests (80k key refused under 100 ms) in Vitest and pgTAP. |
| MED-1 | Deletion with null `source_updated_at` was dropped | Fixed: a delete is applied unless a dated incoming version is older than the stored one; an undated delete keeps the stored provider time. Store has `upsertRawRecordsDetailed` returning `{written, skipped}`; `upsertRawRecords` still returns the number. pgTAP cases. |
| MED-2 | In-batch older version beat the newer | Fixed: dedupe orders by `source_updated_at desc nulls last, n desc`. pgTAP cases. |
| MED-3 | Forbidden-word evasion | Fixed: joined normalised key tested as a word (S.S.N., s_sn, sSN, ssN, zero-width); one trailing plural s stripped (ssns, pins, ibans, rates, tokens); acronym plurals no longer split (SSNs, PINs, IBANs); contained terms acctno, fein, itin, authorization, cookie, passcode, pwd, billingrate; zero-width characters stripped. `secret` and `accountno` now match only at the end of a word (`forbidden_word_ends`), so secretary and accountNotes pass. nextSyncToken and startPageToken are safe token names. Probes in both test suites. |
| MED-4 | Custom-field name/value arrays bypass key-name guards | No code. Recorded in docs/plan-review.md: adapters must drop or allowlist QBO `CustomField` and GHL `customFields`. |
| LOW-2 | TS size measure under-counts exponent-form numbers; zod accepts 9+ fractional digits that SQL refuses | Fixed: numbers JSON prints in exponent form count 330 extra bytes; store checks timestamps with the same regex as SQL (`RAW_TIMESTAMP_RE`, pinned to the migration by a test). |
| LOW-3 | `!deep` sentinel could collide with a key | Fixed: `payload_key_names` returns `(k, is_deep)`; test stores a key named `!deep` (SQL and TS). |
| LOW-4 | `stripForbidden` lost an own `__proto__` key | Fixed: copied with `defineProperty`; test. |
| LOW-5 | Several TS walks | Partly: NUL and key length share one walk (`payloadProblem`), the guards scan once. Left as is: JSON size is a separate stringify. |

Known and accepted (not fixed): containment false positives caffeine, itinerary, sewage (fein, itin, wage are substring terms); run-together all-caps or lower-case names (`EMPLOYEESSN`, `employeessn`, `sSNLast`, `secretsmanager`); a punctuated word glued to another (`employee.S.S.N`); cross-script look-alikes; the first-round deferrals.

## Round 4 (security-reviewer on 02f8d64)
| ID | Finding | Resolution |
|---|---|---|
| HIGH-1 | A replayed update with an equal `source_updated_at` undid an undated deletion (the delete keeps the stored time, and `>=` let the replay through). | Fixed: equal time applies only for a deletion or over a non-deleted row; strictly newer dated update still un-deletes (intended: newer version means restored). pgTAP added. |
| MED-1 | In-batch dedupe let a dated update beat an undated deletion, unlike across batches. | Fixed: order by `(deleted and source_updated_at is null) desc` first. pgTAP added. |
