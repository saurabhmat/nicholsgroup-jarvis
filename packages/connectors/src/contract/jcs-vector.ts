// One test vector for the approval hash (docs/specs/approvals.md §4; T-050 final security review F-M1, done in T-195).
// The connector's `computePayloadSha256` and the approvals module's `hashOfRow` must produce these exact bytes: both tests import
// this file (`@nichols/connectors/writer`). The canonical text and digests were produced independently of this code (Python:
// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) + hashlib.sha256), so a change to either side that
// drifts from RFC 8785 for this subset fails both suites.
import type { ApprovedActionShape } from "./writer";

export type JcsVector = {
  name: string;
  /** The six hashed fields; `payload_sha256` is the expected digest. */
  input: Pick<ApprovedActionShape, "lane_id" | "action_type" | "connection_id" | "target" | "payload" | "payload_schema_version">;
  /** The exact canonical (JCS) JSON text that is hashed. */
  canonical: string;
  sha256: string;
};

export const JCS_TEST_VECTORS: readonly JcsVector[] = [
  {
    name: "qbo.disconnect, empty payload",
    input: {"lane_id": "PKG", "action_type": "qbo.disconnect", "connection_id": "00000000-0000-4000-8000-00000000c195", "target": {"realm_id": "9341450000000001"}, "payload": {}, "payload_schema_version": 1} as JcsVector["input"],
    canonical: "{\"action_type\":\"qbo.disconnect\",\"connection_id\":\"00000000-0000-4000-8000-00000000c195\",\"lane_id\":\"PKG\",\"payload\":{},\"payload_schema_version\":1,\"target\":{\"realm_id\":\"9341450000000001\"}}",
    sha256: "ed447d9c0a3a7ddc139320bd04a2df60b4a67e302afe9c6f45e37dc6473dde05",
  },
  {
    name: "key order, unicode, numbers, nesting, escapes",
    input: {"payload_schema_version": 2, "payload": {"z": 1, "a": {"b": [1, 2.5, null, true], "A": "é\u2028"}, "m": "\"quoted\" \\ \n"}, "target": {"b": 2, "a": 1}, "connection_id": "00000000-0000-4000-8000-00000000c196", "action_type": "email.send", "lane_id": "APK"} as JcsVector["input"],
    canonical: "{\"action_type\":\"email.send\",\"connection_id\":\"00000000-0000-4000-8000-00000000c196\",\"lane_id\":\"APK\",\"payload\":{\"a\":{\"A\":\"\u00e9\u2028\",\"b\":[1,2.5,null,true]},\"m\":\"\\\"quoted\\\" \\\\ \\n\",\"z\":1},\"payload_schema_version\":2,\"target\":{\"a\":1,\"b\":2}}",
    sha256: "8e1f0b6a79c904b2a54b150fbf83b4acbe18d01b5626647469b2c8c40a8b0d74",
  },
];
