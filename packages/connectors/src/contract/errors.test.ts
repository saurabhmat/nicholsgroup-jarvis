import { describe, expect, it } from "vitest";
import { ConnectorError, dispositionFor, isConnectorError } from "./errors";
import { ConnectorErrorInfoSchema } from "./schemas";

describe("dispositionFor", () => {
  it("retries transient failures only", () => {
    expect(dispositionFor("transient")).toBe("retry");
    expect(dispositionFor("rate_limited")).toBe("retry");
    expect(dispositionFor("timeout")).toBe("retry");
  });

  it("never retries reconnect_required (invalid_grant)", () => {
    expect(dispositionFor("reconnect_required")).toBe("reconnect_required");
  });

  it("fails the rest with a message", () => {
    for (const kind of ["lane_mismatch", "connection_unavailable", "unsupported_op", "invalid_input", "not_found", "forbidden", "provider_error"] as const) {
      expect(dispositionFor(kind)).toBe("fail");
    }
  });
});

describe("ConnectorError", () => {
  it("builds valid info with defaults and the provider transaction id", () => {
    const err = new ConnectorError({ kind: "rate_limited", message: "Rate limited", http_status: 429, provider_tid: "tid-1", retry_after_seconds: 5 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConnectorError");
    expect(err.info.disposition).toBe("retry");
    expect(err.info.provider_tid).toBe("tid-1");
    expect(err.info.provider_error_code).toBeNull();
    expect(ConnectorErrorInfoSchema.safeParse(err.info).success).toBe(true);
  });

  it("serialises to info only (no stack, no cause)", () => {
    const err = new ConnectorError({ kind: "provider_error", message: "Provider rejected the request" });
    const json = JSON.parse(JSON.stringify(err));
    expect(json).toEqual(err.info);
    expect(json.stack).toBeUndefined();
    expect("cause" in err).toBe(false);
  });

  it("truncates overlong messages to the schema limit", () => {
    const err = new ConnectorError({ kind: "provider_error", message: "x".repeat(5000) });
    expect(ConnectorErrorInfoSchema.safeParse(err.info).success).toBe(true);
  });

  it("is recognised by isConnectorError", () => {
    expect(isConnectorError(new ConnectorError({ kind: "not_found", message: "Not found" }))).toBe(true);
    expect(isConnectorError(new Error("x"))).toBe(false);
    expect(isConnectorError({ name: "ConnectorError" })).toBe(false);
  });
});
