// Root: the read-side connector contract only. The write side lives at `@nichols/connectors/writer` (approvals only)
// and the contract test kit + mock connector at `@nichols/connectors/testing` (tests only).
export const PACKAGE_ID = "connectors" as const;
export * from "./contract/index";
