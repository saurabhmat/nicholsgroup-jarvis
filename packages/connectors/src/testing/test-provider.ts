// Test-only provider id. Never part of `ProviderSchema`, so it cannot be stored as real data (T-031 check constraint).
import { z } from "zod";
import { buildProviderSchemas, PROVIDERS } from "../contract/schemas";

export const TEST_PROVIDER = "mock" as const;
export const TestProviderSchema = z.enum([...PROVIDERS, TEST_PROVIDER]);
export type TestProvider = z.infer<typeof TestProviderSchema>;

/** Provider-bound schemas that accept real providers plus the test-only `mock`. Used by the contract kit. */
export const testSchemas = buildProviderSchemas(TestProviderSchema);
