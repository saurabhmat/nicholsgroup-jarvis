export const PACKAGE_ID = "ai" as const;
export * from "./types";
export { UNTRUSTED_DATA_RULE, UNTRUSTED_TAG, wrapUntrusted, wrapExcept, escapeUntrusted, containsUntrustedTag, UntrustedDataError } from "./untrusted";
export { createAnthropicProvider, buildParams, STREAM_ABOVE_MAX_TOKENS, MAX_TOKENS_CEILING, DEFAULT_TIMEOUT_MS } from "./anthropic";
export type { AnthropicLike, AnthropicProviderOptions } from "./anthropic";
// getLLMProvider: `@nichols/ai/config`. Mock provider: `@nichols/ai/testing` (test files only). Types only, safe for
// any bundle: `@nichols/ai/types`.
