import { describe, expect, it } from "vitest";
import {
  ConnectInputSchema,
  ConnectionSchema,
  ConnectionStatusSchema,
  ConnectorErrorInfoSchema,
  HealthStatusSchema,
  ProposedPayloadSchema,
  ProviderSchema,
  RawRecordSchema,
  ReadOpSchema,
  SourceResultSchema,
  sourceResultSchema,
  SyncSummarySchema,
} from "./schemas";
import { z } from "zod";

const LANE = "lane-synthetic-a";
const CONN_ID = "00000000-0000-4000-8000-000000000001";
const T0 = "2026-10-28T12:00:00.000Z";

function omit<T extends object>(obj: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...obj };
  delete copy[key];
  return copy;
}

const connection = {
  id: CONN_ID,
  lane_id: LANE,
  provider: "quickbooks",
  external_account_id: "synthetic-realm-1",
  status: "active",
  features: { class_tracking: true, multicurrency: false },
  features_checked_at: T0,
  token_expires_at: T0,
  last_sync_at: null,
  last_error: null,
};

describe("ProviderSchema", () => {
  it("accepts known providers and rejects unknown ones", () => {
    expect(ProviderSchema.parse("quickbooks")).toBe("quickbooks");
    expect(ProviderSchema.safeParse("acme-ledger").success).toBe(false);
  });

  it("does not accept the test-only mock provider", () => {
    expect(ProviderSchema.safeParse("mock").success).toBe(false);
    expect(ConnectionSchema.safeParse({ ...connection, provider: "mock" }).success).toBe(false);
  });
});

describe("ConnectionStatusSchema", () => {
  it("includes reconnect_required and disconnected", () => {
    expect(ConnectionStatusSchema.parse("reconnect_required")).toBe("reconnect_required");
    expect(ConnectionStatusSchema.parse("disconnected")).toBe("disconnected");
  });
});

describe("ConnectionSchema", () => {
  it("parses a synthetic connection with edition feature flags", () => {
    const parsed = ConnectionSchema.parse(connection);
    expect(parsed.features.class_tracking).toBe(true);
  });

  it("defaults features to an empty object", () => {
    expect(ConnectionSchema.parse(omit(connection, "features")).features).toEqual({});
  });

  it("rejects token-like fields (strict object)", () => {
    expect(ConnectionSchema.safeParse({ ...connection, access_token: "x" }).success).toBe(false);
    expect(ConnectionSchema.safeParse({ ...connection, refresh_token: "x" }).success).toBe(false);
  });

  it("requires lane_id", () => {
    expect(ConnectionSchema.safeParse(omit(connection, "lane_id")).success).toBe(false);
    expect(ConnectionSchema.safeParse({ ...connection, lane_id: "" }).success).toBe(false);
  });

  it("rejects malformed feature keys", () => {
    expect(ConnectionSchema.safeParse({ ...connection, features: { "Class Tracking": true } }).success).toBe(false);
  });

  it("rejects datetimes without an offset", () => {
    expect(ConnectionSchema.safeParse({ ...connection, token_expires_at: "2026-10-28T12:00:00" }).success).toBe(false);
  });
});

describe("ConnectInputSchema", () => {
  it("parses an oauth code input and rejects unknown kinds", () => {
    const input = { kind: "oauth_code", code: "synthetic-code", redirect_uri: "https://example.test/cb" };
    expect(ConnectInputSchema.parse(input).kind).toBe("oauth_code");
    expect(ConnectInputSchema.safeParse({ ...input, kind: "playground_token" }).success).toBe(false);
  });

  it("rejects a non-https redirect uri except loopback", () => {
    const base = { kind: "oauth_code", code: "c" };
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "http://evil.test/cb" }).success).toBe(false);
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "http://localhost:3000/cb" }).success).toBe(true);
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "http://127.0.0.1:3000/cb" }).success).toBe(true);
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "http://[::1]:3000/cb" }).success).toBe(true);
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "http://localhost.evil.test/cb" }).success).toBe(false);
  });

  it("rejects redirect uris with userinfo or a fragment", () => {
    const base = { kind: "oauth_code", code: "c" };
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "https://user:pw@example.test/cb" }).success).toBe(false);
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "https://example.test/cb#frag" }).success).toBe(false);
    expect(ConnectInputSchema.safeParse({ ...base, redirect_uri: "https://example.test/cb#" }).success).toBe(false);
  });

  it("returns a validation failure (not a TypeError) for a non-URL redirect uri", () => {
    const result = ConnectInputSchema.safeParse({ kind: "oauth_code", code: "c", redirect_uri: "not a url" });
    expect(result.success).toBe(false);
  });

  it("parses a vault secret reference and never a raw secret", () => {
    const ref = { kind: "vault_secret", secret_ref: "00000000-0000-4000-8000-000000000009", external_account_id: "acct_synthetic" };
    expect(ConnectInputSchema.parse(ref).kind).toBe("vault_secret");
    expect(ConnectInputSchema.safeParse({ ...ref, secret_ref: "rk_test_synthetic" }).success).toBe(false);
    expect(ConnectInputSchema.safeParse({ ...ref, api_key: "rk_test_synthetic" }).success).toBe(false);
    expect(ConnectInputSchema.safeParse({ kind: "vault_secret", secret_ref: ref.secret_ref }).success).toBe(false);
  });
});

describe("ReadOpSchema", () => {
  it("accepts dotted op names with JSON params", () => {
    const op = ReadOpSchema.parse({ op: "report.profit_and_loss", params: { start: "2026-10-01" } });
    expect(op.op).toBe("report.profit_and_loss");
  });

  it("defaults params and rejects bad op names", () => {
    expect(ReadOpSchema.parse({ op: "entity.get" }).params).toEqual({});
    expect(ReadOpSchema.safeParse({ op: "DROP TABLE" }).success).toBe(false);
    expect(ReadOpSchema.safeParse({ op: "x", params: { d: new Date() } }).success).toBe(false);
  });
});

describe("SourceResultSchema", () => {
  const result = {
    lane_id: LANE,
    provider: "quickbooks",
    connection_id: CONN_ID,
    op: "report.profit_and_loss",
    data: { total: "100.00" },
    as_of: T0,
    fetched_at: T0,
    freshness: "live",
    provider_tid: "synthetic-tid-1",
    notes: [],
  };

  it("parses a result carrying as_of, freshness and provider_tid", () => {
    expect(SourceResultSchema.parse(result).freshness).toBe("live");
  });

  it("requires as_of and a valid freshness label", () => {
    expect(SourceResultSchema.safeParse(omit(result, "as_of")).success).toBe(false);
    expect(SourceResultSchema.safeParse({ ...result, freshness: "fresh" }).success).toBe(false);
  });

  it("can validate typed data", () => {
    const schema = sourceResultSchema(z.object({ total: z.string() }));
    expect(schema.safeParse(result).success).toBe(true);
    expect(schema.safeParse({ ...result, data: { total: 1 } }).success).toBe(false);
  });
});

describe("RawRecordSchema", () => {
  const record = {
    lane_id: LANE,
    provider: "quickbooks",
    connection_id: CONN_ID,
    object_type: "Invoice",
    external_id: "synthetic-1",
    payload: { Id: "synthetic-1", TotalAmt: 10 },
    source_updated_at: T0,
    deleted: false,
    synced_at: T0,
  };

  it("parses a raw record", () => {
    expect(RawRecordSchema.parse(record).object_type).toBe("Invoice");
  });

  it("requires a JSON object payload", () => {
    expect(RawRecordSchema.safeParse({ ...record, payload: [1, 2] }).success).toBe(false);
    expect(RawRecordSchema.safeParse({ ...record, external_id: "" }).success).toBe(false);
  });
});

describe("SyncSummarySchema", () => {
  it("parses incremental and full summaries", () => {
    expect(SyncSummarySchema.parse({ cursor: { value: T0 }, mode: "full", records: 3, provider_tid: null }).mode).toBe("full");
    expect(SyncSummarySchema.safeParse({ cursor: { value: "" }, mode: "incremental", records: 0, provider_tid: null }).success).toBe(false);
  });
});

describe("HealthStatusSchema", () => {
  it("parses ok and failing health", () => {
    expect(
      HealthStatusSchema.parse({
        ok: true,
        status: "active",
        checked_at: T0,
        features: { class_tracking: false },
        provider_tid: null,
        error: null,
      }).ok,
    ).toBe(true);
  });
});

describe("ConnectorErrorInfoSchema", () => {
  it("carries provider_tid and retry_after_seconds", () => {
    const info = ConnectorErrorInfoSchema.parse({
      kind: "rate_limited",
      disposition: "retry",
      message: "Rate limited",
      http_status: 429,
      provider_error_code: null,
      provider_tid: "synthetic-tid",
      retry_after_seconds: 30,
      endpoint: "/v3/company/{realm}/query",
    });
    expect(info.provider_tid).toBe("synthetic-tid");
  });

  it("rejects endpoints carrying a query string or fragment", () => {
    const base = {
      kind: "provider_error",
      disposition: "fail",
      message: "x",
      http_status: 400,
      provider_error_code: null,
      provider_tid: null,
      retry_after_seconds: null,
    };
    expect(ConnectorErrorInfoSchema.safeParse({ ...base, endpoint: "/v3/company/{realm}/query" }).success).toBe(true);
    expect(ConnectorErrorInfoSchema.safeParse({ ...base, endpoint: "/v3/company/1/query?query=select" }).success).toBe(false);
    expect(ConnectorErrorInfoSchema.safeParse({ ...base, endpoint: "/cb#x" }).success).toBe(false);
    expect(ConnectorErrorInfoSchema.safeParse({ ...base, endpoint: "https://host/x" }).success).toBe(false);
  });
});

describe("ProposedPayloadSchema", () => {
  it("rejects a payload that tries to carry a hash or approval", () => {
    const proposed = {
      lane_id: LANE,
      provider: "monday",
      connection_id: CONN_ID,
      action_type: "monday.item.update",
      target: { board_id: "1", item_id: "2" },
      payload: { status: "Done" },
      payload_schema_version: 1,
      expected_before: null,
    };
    expect(ProposedPayloadSchema.parse(proposed).action_type).toBe("monday.item.update");
    expect(ProposedPayloadSchema.safeParse({ ...proposed, payload_sha256: "abc" }).success).toBe(false);
  });
});
