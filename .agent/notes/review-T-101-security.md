# T-101 (+ T-100 fixes) security review (security-reviewer, Nov 8, 2026) — diff 52b16f2..5252004

Verdict: no BLOCKER, no HIGH. 4 MEDIUM, 7 LOW. T-100 MEDIUMs M1, M2 and M3a are fixed. M3b (thinking branding) was deferred on purpose and is documented in .agent/pr/T-100.md.

Solid:
- The definer runs with an empty search_path and uses fully qualified names. It works only for auth.uid() at aal2 and is granted to `authenticated` only. Non-members get `not_member` before any lane, policy or category fact is returned, so there is no cross-lane oracle.
- llm_allowed_categories fails closed (coalesce to '{}'). The rate upsert is atomic and denied calls do not count.
- The gate fails closed on every DB error or odd reply. It checks the role again in TS. Model-facing text is fixed. toolUseId is sanitised and the target is never echoed. Denial metadata has no argument values. Audit failure before the run means the tool does not run.
- The lane comes from the server.
- @nichols/ai root, /config and /tools are server-only. The mock is test-only through lint.
- SDK: baseURL, logLevel and openTelemetry:false are pinned (verified in the SDK 1.6.0 source). CUSTOM_HEADERS and AUTH_TOKEN are refused.
- maxTokens, timeout and laneId are validated. Unknown blocks and stop reasons now fail closed.

## T-100 prior findings
- M1 fixed. anthropic.ts constructor pins baseURL, logLevel "off" and openTelemetry false. Checked against SDK client.js and internal/tracing.js: `false` means traces off, and the env is not read. env/server.ts:76 refuses CUSTOM_HEADERS, BASE_URL, LOG, OTEL content mode and AUTH_TOKEN.
- M2 fixed. buildParams checks that maxTokens is an integer from 1 to 64,000 and that timeoutMs is at most 10 minutes. The default timeout is 2 minutes. The no-retries-on-top rule is documented.
- M3a fixed. The mock is only at @nichols/ai/testing and is on TEST_ONLY_MODULES.
- M3b deferred (documented): thinking blocks are not branded. T-103/T-212 must keep them transient.
- L1, L2 and L4 fixed. L3 (untrusted content kept out of `system`) is deferred to T-102. L6 is covered by server-only.

## MEDIUM

M1. Users can reset or loosen the rate limit by calling the RPC directly. The limit and window come from the caller.
supabase/core/supabase/migrations/20261108090000_ai_tool_gate.sql:24, :48, :81-85; packages/ai/src/tools/gate.ts:79-80.
- Any member with the assistant view can call `core.ai_tool_gate` through PostgREST with their own JWT. They can choose `p_window_seconds=1` or `p_limit=1000`.
- Line 82 deletes every row with `window_start < v_window` for that user and lane. So a direct call with a 1 s window deletes the server's 60 s window row (its start is at or before the current second). The next server call then starts again at 1.
- Each direct call is also a DELETE plus an UPSERT, with no throttle of its own.
- The spec (§4 chat route) says the limit comes from `lane_config.assistant`. Here it is a hard-coded default in TS.
Fix:
- Drop `p_limit` and `p_window_seconds` from the public signature. Read them inside the definer from the lane's config (lane_config.assistant or a lane_policies column), with a fixed fallback.
- Or keep the parameters but add the window size to the primary key, and delete only rows older than now() minus the largest allowed window.
- Add a pgTAP test: a direct call with a different window must not reset the counter.

M2. The registry's schema walk is not exhaustive. Strictness and the lane-field ban can be bypassed below the top level.
packages/ai/src/tools/registry.ts:64-99 (default branch at :96-98).
- `tuple`, `catch`, `prefault`, `success`, `set` and `promise` fall into `default` and return `[]` when not at the top level, so their inner schemas are never walked. Verified with zod 4.6.7:
  - `z.strictObject({ items: z.tuple([z.looseObject({})]) })` parses `{items:[{laneId:"NL"}]}` successfully.
  - A strictObject inside a tuple with a `laneId` key registers.
  - `z.strictObject({ opts: z.strictObject({}).catch({}) })` silently drops a forged `laneId`. It returns success instead of `invalid_args`, so the forgery is not audited (spec §8.1).
Fix:
- Make the walk an allowlist that fails closed. Leaf types allowed: string, number, int, boolean, enum, literal, null, date, template_literal. Walk object, optional, nullable, default, readonly, nonoptional, array, tuple (items and rest) and union.
- Refuse everything else, including catch, prefault, success, set, promise, record, pipe and lazy.
- Add a registry test for each of these.

M3. Tools get no DB client, and the scan does not follow imports, so the "no write path" guarantee is shallow.
- packages/ai/src/tools/gate.ts:153: `run({laneId,userId,role})`. The user's lane client from requireLane (:110-113) is thrown away. Every real tool will have to get its own client (guards, getLaneClient, or worse). Nothing ties that client to `ctx.laneId` or to the user's session. index.ts:1 says "tools run with the user's lane client", which is not true today.
- packages/ai/src/tools/tools.test.ts:202-256: the scan reads only files under `*/src/tools`, by regex. T-104 tools will delegate to the module query layer (`../queries/*`), which is not scanned. The writer-RPC regex misses verbs such as create, set, consume, add, mark, approve, execute, post and send. It also misses `.rpc(variable)`, `schema("fin")` writers with other names, and `.js` or `.mts` files.
Fix:
- Pass the lane-bound user client (already obtained by the gate) in ToolContext, for example `ctx.db: LaneClient`. Lint-ban getLaneClient, guards and service clients inside tool sources.
- Turn the scan into an ESLint rule (or a dependency-graph check such as dependency-cruiser) that follows imports from `*/src/tools/**`. Ban write subpaths, executeWrite, service clients and approvals other than proposeAction across the whole reachable graph.
- At minimum, include each module's query layer and widen the RPC verb list. Write the RPC verb list as an allowlist of read RPCs rather than a denylist of writer verbs.

M4. Some denial paths are written to the audit log without a verified user, and invalid lanes are dropped silently.
packages/ai/src/tools/gate.ts:90-104, :114-116.
- `unknown_tool` is audited before any session check, as actor `system`, into whatever `laneId` the caller passed. The audit sink uses the service client, so this writes into any valid lane's audit log.
- `not_member`, `no_session` and `mfa_required` from requireLane are also logged as `system` because `userId` is still null. A cross-lane attempt therefore cannot be attributed to the user who made it.
- A malformed laneId fails `entrySchema` and the `.catch` swallows it, so that denial is not recorded at all.
Fix:
- Resolve the session first (`requireSession`, allowing AAL1 only to identify the user). Then look up the tool, then requireLane.
- Audit denials as `{kind:"user", userId}` when a session exists. Never write audit rows for a lane the caller is not a member of without the user actor.
- Validate laneId with the core lane schema at the top of `call`, and record an invalid one under a fixed reason (or count it in a metric) instead of dropping it.

## LOW
- L1. gate.ts:141: `tool.args.safeParse` is outside the try. A refine or superRefine callback that throws makes `call()` reject, which breaks "never throws". Fix: wrap it in try and map to `invalid_args`.
- L2. registry.ts:56: `/lane/i` catches lane* keys but not equivalents such as `company`, `tenant` or `realm`. Fine because `entity` is allowed by the spec, but T-104 must validate `entity` against the lane mapping server-side (D-8). Add a registry note and test when T-104 lands.
- L3. Migration :81 uses a fixed window, so a burst of up to 2x the limit is possible at a window boundary. Accept it, or use a two-bucket sliding estimate.
- L4. 260_ai_tool_gate.test.sql has no table-privilege check for `service_role` on core.ai_tool_rate, only for `authenticated`. It also has no test for direct calls with a different window (see M1). Add both.
- L5. env/server.ts:76: the refused-env check runs only in getAnthropicEnv. `createAnthropicProvider` (exported from the @nichols/ai root) can be built with any apiKey and still honours ANTHROPIC_CUSTOM_HEADERS. Fix: call a core `assertAnthropicSdkEnvSafe()` from getClient(), or do not export createAnthropicProvider from the root (export it from /config only).
- L6. T-100 M3b is still open: thinking blocks come back raw. Ensure T-103 and T-212 never persist or log them (add a canary test then).
- L7. gate.ts:153: `withAudit.failed` records `error_class = err.name` from tool-thrown errors, and tool authors control that name. Map it to a fixed set of classes (AuthError, LLMProviderError, ZodError, Error) or drop it.

Status: not yet fixed.
