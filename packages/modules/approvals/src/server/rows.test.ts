// The approvals side of the shared JCS test vector (T-050 F-M1, T-195): `hashOfRow` hashes a stored row exactly as the
// connector's `computePayloadSha256` does. Both suites run the same independently computed vectors from
// `@nichols/connectors/writer` (the connector side: packages/connectors/src/contract/jcs-vector.test.ts).
import { computePayloadSha256, JCS_TEST_VECTORS } from "@nichols/connectors/writer";
import { describe, expect, it } from "vitest";
import { hashOfRow, toRow } from "./rows";

describe("hashOfRow and the shared JCS vector", () => {
  it.each(JCS_TEST_VECTORS.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const row = {
      laneId: v.input.lane_id,
      actionType: v.input.action_type as never,
      connectionId: v.input.connection_id,
      target: v.input.target as Record<string, unknown>,
      payload: v.input.payload as Record<string, unknown>,
      payloadSchemaVersion: v.input.payload_schema_version,
    };
    expect(hashOfRow(row)).toBe(v.sha256);
    expect(computePayloadSha256(v.input)).toBe(v.sha256);
  });

  it("the stored-row reader accepts qbo.disconnect and refuses an unknown type", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000001", lane_id: "PKG", action_type: "qbo.disconnect", connection_id: "00000000-0000-4000-8000-000000000002", provider: "quickbooks",
      target: { realm_id: "9341450000000001" }, payload: {}, payload_schema_version: 1, payload_sha256: "a".repeat(64), rationale: null, source_refs: [], proposer_kind: "user",
      proposer_user_id: null, derived_from_retrieved: false, supersedes_id: null, superseded_by_id: null, status: "proposed", expires_at: "2026-11-14T00:00:00Z", approved_by: null,
      approved_at: null, approved_hash: null, executed_at: null, verified_at: null, result: {}, failure_code: null, payload_purged_at: null, created_at: "2026-11-13T00:00:00Z", updated_at: "2026-11-13T00:00:00Z",
    };
    expect(toRow(base).actionType).toBe("qbo.disconnect");
    expect(() => toRow({ ...base, action_type: "qbo.revoke_grant" })).toThrow();
  });
});
