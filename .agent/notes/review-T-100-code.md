# T-100 code review (code-reviewer, Nov 7, 2026 night) — on e4f74d9

Acceptance met; SDK 1.6.0 calls verified against installed types. BLOCKER: none.

HIGH (interface gaps; fix before T-101/T-212 build on it)
1. No system blocks / prompt caching: `system?: string` (types.ts ~40, anthropic.ts ~72). Make system `string | {text, cache?: "5m"|"1h"}[]`, add `cache?` to tools, text and tool_result blocks -> `cache_control: {type:"ephemeral"}` (+ttl); test markers reach params.
2. tool_result round trip unvalidated/untested: buildParams should enforce tool_result blocks first in the user turn and ids matching the previous assistant tool_use (throw invalid_request); test [thinking, tool_use] -> [tool_result] with signature and order preserved.
3. Streamed calls lose requestId: finalMessage() snapshot has no `_request_id`; read `MessageStream.request_id` (lib/MessageStream.d.ts:33); fix the fake stream so the test catches it.

MEDIUM
4. No per-call timeout (`timeoutMs`), and maxRetries/timeout not configurable via getLLMProvider.
5. server-only blast radius: index re-exports config.ts (imports @nichols/core/env/server). Split `@nichols/ai` (types, mock, factory) from `@nichols/ai/config` (getLLMProvider); update package.json exports.
6. Usage/cost accounting thin (cache by ttl, server tools, failed calls usage null; add onUsage(laneId, tier, model, usage) or estimateCost with prices from config).
7. `new Anthropic(...) as unknown as AnthropicLike` double cast hides SDK drift; add compile-time check or a real-client test with mock fetch checking the wire body.
8. mapContent silently drops unknown block types; throw or test+comment.
9. Thinking contract: document default; expose thinkingDisplay ("omitted" preferred); add to T-103/T-212 acceptance that thinking blocks are never stored/logged (transient only).

LOW: 10 check Haiku 5.5 accepts effort/adaptive; 11 mock should run buildParams validation; 12 mock should clone recorded requests, test MockReply fn; 13 missing tests (signal/abort, 503/529/408/504/403 mapping, tool_use/pause_turn/context-window statuses, null cache tokens, refusal category null, thinking/redacted_thinking mapping, tool schema override); 14 optional vendorType (no body) on error/log; 15 16k stream threshold OK; 16 default logger console.info vs repo logger.

Status: not yet fixed. Security review of e4f74d9 still pending (re-run if its result is lost).
