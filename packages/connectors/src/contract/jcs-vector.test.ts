/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into data they just built */
// The connector side of the shared approval-hash vector (T-050 F-M1, T-195). The approvals module runs the same vectors through
// `hashOfRow` (packages/modules/approvals/src/server/rows.test.ts).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, computePayloadSha256, JCS_TEST_VECTORS } from "./writer";

describe("shared JCS test vector", () => {
  it.each(JCS_TEST_VECTORS.map((v) => [v.name, v] as const))("%s: canonical text and SHA-256 are the independently computed ones", (_name, v) => {
    const { lane_id, action_type, connection_id, target, payload, payload_schema_version } = v.input;
    expect(canonicalJson({ lane_id, action_type, connection_id, target, payload, payload_schema_version })).toBe(v.canonical);
    expect(createHash("sha256").update(v.canonical, "utf8").digest("hex")).toBe(v.sha256);
    expect(computePayloadSha256(v.input)).toBe(v.sha256);
  });

  it("the key order of the input does not matter, a changed field does", () => {
    const v = JCS_TEST_VECTORS[0]!;
    const shuffled = { payload_schema_version: v.input.payload_schema_version, payload: v.input.payload, target: v.input.target, connection_id: v.input.connection_id, action_type: v.input.action_type, lane_id: v.input.lane_id };
    expect(computePayloadSha256(shuffled)).toBe(v.sha256);
    expect(computePayloadSha256({ ...v.input, action_type: "qbo.revoke_grant" })).not.toBe(v.sha256);
    expect(computePayloadSha256({ ...v.input, target: { realm_id: "9341450000000002" } })).not.toBe(v.sha256);
  });
});
