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
