// Test-only entry point (imports vitest and node:util). Never import from application code.
export { contractChecks, describeConnectorContract, runContractCheck } from "./contract-kit";
export type { CheckState, ContractCheck, ContractHarness, ConnectorContractFixture } from "./contract-kit";
export { createMockConnector, mockHarness, MOCK_ACCOUNT_ID, MOCK_AUTH_CODE, MOCK_SECRET_CANARY } from "./mock-connector";
export type { MockConnectorOptions, MockFaults, MockSetup } from "./mock-connector";
export { TEST_PROVIDER, TestProviderSchema, testSchemas } from "./test-provider";
export type { TestProvider } from "./test-provider";
