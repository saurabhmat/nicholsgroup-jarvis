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
