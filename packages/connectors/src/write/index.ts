// `@nichols/connectors/write`: the write-side wiring of each connector, for the approvals module only (rule 5, decided
// D-24: even revoking our own QuickBooks grant at Intuit is an external write). The branded action and the lint that
// restricts this import to packages/modules/approvals arrive with T-193 / the approvals tasks; a test fails meanwhile
// if any other production file imports this subpath or the QuickBooks writer.
export { quickbooksWriter } from "../quickbooks/index";
export { QBO_REVOKE_ACTION, type QboApprovedAction } from "../quickbooks/writer";
