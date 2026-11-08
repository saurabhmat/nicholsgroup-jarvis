# Code review T-102 (9256654..5fd518e)

Verdict: no BLOCKER. Wrapping and loop are sound for the happy path; server-side guarantees come from the T-101 gate. 1 HIGH-for-fit, several MEDIUM test-quality gaps.

## HIGH
H1 packages/ai/src/tools/loop.ts:163 (fit T-105). Loop uses provider.complete only, no hooks. T-105 needs SSE text.delta, tool.start, tool.result, abort on disconnect. Fix: add optional callbacks (onToolStart(name,id), onToolResult(record), onText) and, if LLMProvider gains stream, a streaming step; at minimum emit events around gate.call. Otherwise T-105 forks the loop and loses the injection guarantees.
H2 loop.ts:198. input.signal is not forwarded to gate.call (GateCall accepts signal, gate.ts passes it to tool.run). Tools keep running after disconnect. Fix: pass `...(input.signal ? { signal: input.signal } : {})`; also check signal.aborted between steps.

## MEDIUM
M1 loop.ts:187-196. propose_not_allowed is refused before the gate: not audited (spec: denied calls audited with reason) and not rate-limited. Fix: audit via a gate/audit hook, or move the userInitiated check into the gate.
M2 loop.ts:177-181. maxSteps=6 yields 5 tool rounds; the 6th model call's tool_use is discarded and the user gets partial/empty text. Fix: on the last step call the provider without tools (or tool_choice none) so it must answer; keep stop "max_steps" only if it still returns tool_use. Also doc that the returned history ends in a user tool_result (T-105 must merge with the next user message).
M3 loop.ts:174. status "paused" (pause_turn) is returned as terminal. Resume requires re-sending the assistant content; callers will mishandle. Fix: continue the loop on paused (count a step), or document and test it.
M4 loop.ts:122-136 / untrusted.ts. Wrapping depends on each tool declaring untrustedFields; finance tools (T-104) returning names without the declaration go unwrapped, and nothing tests it. Source `url`, `id`, `kind` and tool `notes` are unwrapped though they can carry external text (web url, message id). Fix: wrap/validate source.url and id (or drop url for the model), and add a registry test: any tool with resultStore/ category email|docs|web must declare fields; T-104 gets a review item per PR note.
M5 injection.test.ts (assertServerSide, ~line 195-206): attacker calls only asserted `not "ok"`; PR claims reasons (unknown tool, invalid args, category denied). A call refused for the wrong reason passes. Fix: add `expectReason` per attack in corpus.ts and assert it.
M6 injection.test.ts secrets check (~line 235-238): canaries are never placed anywhere reachable (session token lives only in the requireLane stub; the sk-ant and sb_secret strings appear nowhere), and email-exfiltrate-secrets has attack []. The check is vacuous. Fix: put a canary in the system prompt, in a tool error message thrown by run (gate maps to tool_failed), in env; assert tool ctx passed to run has no accessToken; assert the final answer and every provider request lack it.
M7 injection.test.ts ~line 214 `expect(sys).not.toContain(c.payload)` and :229 compare JSON.stringify output with raw payloads; payloads with quotes/newlines (doc-forged-args) are escaped by JSON so the check passes trivially. Fix: compare against JSON.stringify(payload).slice(1,-1) or inspect message objects directly.
M8 Real-model path (injection.test.ts last describe): attack ids `tu_attack_*` never exist for a real model, so "attacks refused" is vacuous; no assertion that real requests were wrapped (provider.calls unavailable). Fix: wrap the real provider in a recording proxy and reuse the same assertions on all tool_use blocks (any non-read tool or any outcome != ok/denied must fail); skip with a clear message (describe.skipIf) rather than failing when unconfigured, and cap maxTokens/steps for cost. Also vitest does not load .env: document exporting ANTHROPIC_*.
M9 Missing loop tests: refused / max_tokens / paused stops, several tool_use blocks in one turn (mixed legit+attack, result ordering), gate returning tool_failed, abort signal, steps/toolCalls counts at maxSteps, multi-turn history carrying an earlier tool_result (stored history must still be wrapped). Spec §4 also lists "grounding check intact": not covered (defer to T-105 explicitly in backlog/PR).
M10 Escaping side effect: `&`,`<`,`>` in names become entities (AT&amp;T). Rule text does not tell the model the content is entity-escaped, so quotes in answers show "&amp;". Fix: add a sentence to UNTRUSTED_DATA_RULE ("text inside is HTML-escaped; read &lt; as <") and decode in citations/UI for T-105. Untested.

## LOW
L1 untrusted.ts:45-57. Object keys of external data (Record<customerName, amount>) are never wrapped. structuredClone drops Date to {} through wrapAll (Object.entries(Date)=[]) and throws on functions/bigint: tool data must be JSON; enforce with toolResultSchema/JSON round trip first.
L2 untrusted.ts:62. id for wrapped strings is the path plus index ("customers[].name.0"), not a record id; provenance is weak for citations. Let tools supply an idPath (e.g. "customers[].id").
L3 untrusted.ts:19 ATTR allows `[]`/`/`/`@`; fine, but unsafe values silently become "unknown" which loses provenance; log or test the 120-char limit.
L4 loop.ts:141 rule dedupe uses exact substring; T-212 must import UNTRUSTED_DATA_RULE verbatim (add a note in assistant spec §4 prompt section) and put it in the cached static prefix, else withRule appends an uncached block each call.
L5 loop.ts:198-205 gate outcome `auditIncomplete` ignored; surface it in ToolCallRecord for T-105.
L6 loop.ts:210 `/* c8 ignore next */` unreachable throw: restructure to avoid it.
L7 package.json: test:injection runs again inside `pnpm test` (harmless duplicate); fine. No new dependencies; no scope creep.

## Fit
- T-212: ok if it imports UNTRUSTED_DATA_RULE and never inlines retrieved content (loop throws otherwise: good).
- T-105: needs H1/H2, M2, M3 first.
