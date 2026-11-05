# T-064 security review (parent) and resolution
Result: 0 BLOCKER, 0 HIGH. Findings and what was done:
- M1 selection only checked at run start -> FIXED: cursor holds a selection fingerprint (`s`) and discovery flag (`d`); settings are read on every `sync`; a changed fingerprint re-runs discovery before any events request. Test: mid-run settings change makes zero requests for the excluded calendars.
- M2 rows of calendars that left the selection linger -> FIXED: `dropCalendars` on the sync result, `p_drop_calendars text[]` (max 10, validated, lane + connection scoped) on `core.cal_events_apply_page`, applied with the first chunk; never after a failed or partial calendarList read (more than 5 pages is an error). pgTAP: only that lane/connection/calendar is deleted, APK's same-named calendar untouched.
- L1 decode not a bijection -> FIXED (`encodeCalendarId(raw) === encoded`), tests.
- L2 shared www.googleapis.com client -> FIXED: `createGoogleHttp` allows only CALENDAR_PATHS on that host; token/revoke clients use `GOOGLE_TOKEN_HOSTS`, the connect-time profile client `GOOGLE_GMAIL_HOSTS`. Tests.
- L3 un-cancel on equal version -> FIXED in SQL and the harness twin; pgTAP.
- L4 cursor prefix -> FIXED for calendar (22023 unless `g1.<connection id>.c:`; pgTAP). Mail apply NOT changed (merged T-063 migration, ~60 fixtures): logged in plan-review.
- L5 service_role write grants -> header comment corrected; revoke NOT done (purge functions are invoker, T-061 tests write directly): logged.
- L6 `calendar_ids: []` -> refused by core schema and connector reader.
