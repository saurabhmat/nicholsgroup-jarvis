# T-039 security review (Nov 2, 2026)

Reviewer note: the `security-reviewer` subagent could not be launched from this run (no sub-agent tool was available to the builder), so this is a structured self-review of the diff against the CLAUDE.md rules and the T-035 review checklist. It needs the human's second pass or a re-run with the subagent.

Result: 0 BLOCKER, 0 HIGH. 3 MEDIUM and 3 LOW logged.

Checked and fine
- Access: `raw.source_records` has RLS on, no policy and no grant to anon, authenticated or service_role (catalog test pins this); schema `raw` has no usage for API roles and is not in config.toml `schemas`. Only `core.source_records_upsert` writes, SECURITY DEFINER with `search_path = ''`, execute for service_role only (pgTAP: owner at aal2 and anon denied).
- Lane isolation: the function resolves the provider from `core.connections where id and lane_id` (same error for unknown and other-lane); the table has a composite FK (connection_id, lane_id); TS asserts lane-bound connection and rejects any record whose lane, connection or provider differs (nothing written). Cross-lane tests in pgTAP and Vitest.
- Rule 6: guard in TS (policy read through the lane's job client, missing/erroring policy = not allowed) and a table trigger (every writer, including a future one). Error text carries neither key nor value.
- Hash set by trigger, not the caller. Payload must be a JSON object, at most 1 MB. Batch cap 1000 in SQL, 500 in TS.
- Errors from the database are replaced by fixed messages. No logging added.

Findings (logged, not blocking)
- M1: the body-field list is a key-name heuristic. Provider shapes with content under other names (Google Calendar `description`, Drive `description`, Notion nested property text) pass. Each connector adapter (T-050+, google/microsoft/notion) must project to metadata before the sink, and add provider names to both lists (SQL + TS; a test pins that they match).
- M2: raw payloads for finance providers are stored whole; they may contain provider-side secrets-like fields (e.g. Stripe `client_secret` on payment intents). No `jsonb_has_secret` check was added because it would fail legitimate syncs; adapters should drop such fields. Decide with T-051/T-052.
- M3: no read path yet. Normalizers need a reviewed definer read function (lane-checked) when the first one is built; today nothing can read the table except the owner.
- L1: `deleted` rows keep their payload until retention (T-042) must register this table.
- L2: payload_hash uses jsonb text form, stable per jsonb value but not RFC 8785; only used for change detection.
- L3: `synced_at` is updated on every upsert even if the payload is unchanged (churn, not a leak).
