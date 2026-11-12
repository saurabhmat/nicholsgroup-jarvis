// Test-only entry (lint: test files only). The mock keeps prompts in memory.
export { createMockProvider, textResult, webSearchResult } from "./mock";
export type { MockLLMProvider, MockReply } from "./mock";
