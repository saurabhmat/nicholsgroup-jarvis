export const PACKAGE_ID = "ai" as const;
export * from "./types";
export { createAnthropicProvider, buildParams, STREAM_ABOVE_MAX_TOKENS } from "./anthropic";
export type { AnthropicLike, AnthropicProviderOptions } from "./anthropic";
export { createMockProvider, textResult } from "./mock";
export type { MockLLMProvider, MockReply } from "./mock";
export { getLLMProvider } from "./config";
export type { ProviderResult } from "./config";
