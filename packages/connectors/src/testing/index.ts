// Test-only entry point (imports vitest). Never import from application code.
export { contractChecks, describeConnectorContract } from "./contract-kit";
export type { ContractCheck, ContractHarness, ConnectorContractFixture } from "./contract-kit";
export { createMockConnector, mockHarness, MOCK_AUTH_CODE, MOCK_SECRET_CANARY } from "./mock-connector";
export type { MockConnector, MockConnectorOptions } from "./mock-connector";
