# T-100 security review (security-reviewer, Nov 7, 2026 night) — on e4f74d9

Verdict: no BLOCKER, no HIGH. 3 MEDIUM, 6 LOW. Solid: key only via getAnthropicEnv, client never falls back to env key; server-only import blocks client bundles; fixed error messages, no vendor bodies; LLMCallLog has no text; request-shape rules enforced; laneId required; SDK confined to packages/ai.

MEDIUM
- M1 SDK env vars can enable body logging / tracing / endpoint change: ANTHROPIC_LOG=debug (full request body via console), ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE=content, ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS (anthropic.ts:216). Fix: pin baseURL, logLevel "off", openTelemetry content mode metadata_only/disabled in the constructor; test that the env vars are ignored; optionally refuse them in the production env schema. Recommended to fix now.
- M2 maxTokens unvalidated; SDK 2 retries + caller retries multiply cost; default 10-min timeout per attempt. Fix: Zod-validate LLMRequest (maxTokens int 1..ceiling, laneId format, messages non-empty); explicit timeout; document no caller retries on top (maxRetries 0 inside Inngest steps); per-lane spend caps in T-101/T-102.
- M3 mock exported from package root (keeps prompts in memory); thinking text in results unprotected. Fix: move mock to `@nichols/ai/testing` + no-restricted-imports outside tests; brand thinking blocks / toJSON "[thinking]".

LOW: L1 unknown stop_reason mapped to completed (fail closed instead); L2 laneId only non-empty (use core lane-id schema); L3 no structural guard keeping untrusted content out of `system` (T-101/T-102); L4 streamed requestId null (same as code review HIGH 3); L5 "does not expose key" test is vacuous; L6 lint that "use client" files never import @nichols/ai.

Status: not yet fixed.
