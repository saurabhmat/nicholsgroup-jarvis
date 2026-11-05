# T-064 code review (parent) and resolution
Result: 0 BLOCKER, 0 HIGH.
- M1 permanent per-calendar failure wedged the connection -> FIXED: 404, non-rate-limit 403, 400 on an initial load, malformed page, unexpected page/sync token all skip that calendar (content-free `google.calendar.calendar_skipped` log with a reason code) and advance. rate_limited, transient, reconnect_required still throw. Test: 403/400/token/shape failures on the middle calendar, the third still syncs.
- M2 404 at position 0 looped (rediscovery inferred from i === 0) -> FIXED with the explicit `d` (discovered this run) flag in the cursor; regression test with an explicit list excluding primary: one request, bounded pages.
- L3 CURSOR_RE 16000 vs MAX_CURSOR -> aligned (16384), parse also rejects longer values; the max-size test stays.
- L4 test page-token 410 during first full load -> added (one reset, restart, no duplicate rows).
- L6 fake Google too lenient -> rejects showDeleted=false/orderBy/q/updatedMin with a syncToken and a page token used with different parameters (400).
- L8 unexpected token charset -> skip calendar (see M1).
- L5 settings read per page -> accepted, logged.
