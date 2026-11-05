import { describe, expect, it, vi } from "vitest";
import { AuditError, createAudit, isSensitiveKey, REDACTED, redactMetadata, withAudit, type AuditRow, type AuditSink } from "./index";

const USER = "00000000-0000-4000-8000-000000000001";
const ENTRY = { laneId: "PKG", actor: { kind: "user", userId: USER }, action: "lane_config.version_created", target: "lane_config:PKG:2" } as const;

describe("redactMetadata", () => {
  it("drops credential- and content-named fields in any case style", () => {
    const out = redactMetadata({
      version: 2,
      accessToken: "x",
      refresh_token: "x",
      "api-key": "x",
      apiKey: "x",
      clientSecret: "x",
      Authorization: "x",
      email_body: "x",
      bodyHtml: "x",
      subject: "x",
      snippet: "x",
      prompt: "x",
      nested: { password: "x", ok: true },
    });
    expect(out).toEqual({ version: 2, nested: { ok: true } });
  });

  it("keeps ordinary fields, including counts that mention tokens", () => {
    expect(isSensitiveKey("input_tokens")).toBe(false);
    expect(isSensitiveKey("idempotency_key")).toBe(false);
    expect(isSensitiveKey("monkey")).toBe(false);
    expect(redactMetadata({ input_tokens: 10, status: "ok", ids: ["a", "b"] })).toEqual({ input_tokens: 10, status: "ok", ids: ["a", "b"] });
  });

  it("replaces secret-looking values wherever they are", () => {
    const out = redactMetadata({ ref: "sk_live_abc", list: ["  sb_secret_x", "fine"], other: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" });
    expect(out).toEqual({ ref: REDACTED, list: [REDACTED, "fine"], other: REDACTED });
  });

  it("truncates long strings and bounds depth, arrays and total size", () => {
    const out = redactMetadata({ long: "a".repeat(500), deep: { a: { b: { c: { d: 1 } } } }, many: Array.from({ length: 80 }, (_, i) => i) });
    expect(String(out.long)).toHaveLength(200 + "…[truncated]".length);
    expect(out.deep).toEqual({ a: { b: { c: "[too deep]" } } });
    expect(out.many).toHaveLength(50);
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${String(i)}`, "v".repeat(100)]));
    expect(redactMetadata(wide)).toEqual({ _truncated: true });
  });

  it("drops values JSON cannot hold and normalises the rest", () => {
    const out = redactMetadata({ f: () => 1, u: undefined, n: Number.NaN, b: 10n, d: new Date("2026-10-31T00:00:00Z") });
    expect(out).toEqual({ n: null, b: "10", d: "2026-10-31T00:00:00.000Z" });
  });
});

describe("redactMetadata (review fixes)", () => {
  it("drops plural and bare credential keys, personal data and error internals", () => {
    const out = redactMetadata({
      tokens: ["x"], refreshTokens: ["x"], secrets: "x", passwords: "x", key: "x", accessKey: "x", signingKey: "x",
      jwt: "x", code: "x", ssn: "x", account_number: "x", iban: "x", salary: 1, details: "Failing row contains (x)",
      hint: "x", query: "select", stack: "x",
      input_tokens: 5, output_tokens: 7, idempotency_key: "k", error_code: "23514", status: "ok",
    });
    expect(out).toEqual({ input_tokens: 5, output_tokens: 7, idempotency_key: "k", error_code: "23514", status: "ok" });
  });

  it("replaces more credential value shapes", () => {
    const out = redactMetadata({ a: "Bearer eyJabc", b: "Basic dXNlcjpwdw==", c: "ya29.a0Af", d: "glpat-abc", e: "https://example.test/cb?code=abc" });
    expect(Object.values(out)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it("never walks binary data, Maps, Sets or class instances", () => {
    const out = redactMetadata({ buf: Buffer.from("sk_live_abcdef"), map: new Map([["a", "sk_live_x"]]), set: new Set([1]), err: new Error("boom") });
    expect(out).toEqual({ buf: "[binary]", map: "[object]", set: "[object]", err: "[object]" });
  });

  it("skips prototype keys and returns a plain object", () => {
    const out = redactMetadata(JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>);
    expect(out).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("caps keys per object", () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${String(i)}`, i]));
    const out = redactMetadata(many);
    expect(Object.keys(out)).toHaveLength(201);
    expect(out._more_keys).toBe(true);
  });
});

describe("createAudit", () => {
  it("writes the audit.log() row with redacted metadata", async () => {
    const sink = vi.fn<AuditSink>(async () => {});
    await createAudit(sink).log({ ...ENTRY, metadata: { version: 2, token: "x" } });
    expect(sink).toHaveBeenCalledWith({
      p_lane_id: "PKG",
      p_actor_kind: "user",
      p_actor_id: USER,
      p_action: "lane_config.version_created",
      p_target: "lane_config:PKG:2",
      p_metadata: { version: 2 },
    });
  });

  it("maps service and system actors to a null actor id", async () => {
    const sink = vi.fn<AuditSink>(async () => {});
    await createAudit(sink).log({ laneId: "PKG", actor: { kind: "service" }, action: "sync.run_finished" });
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ p_actor_kind: "service", p_actor_id: null, p_target: null, p_metadata: {} });
  });

  it("rejects invalid entries before writing", async () => {
    const sink = vi.fn<AuditSink>(async () => {});
    const audit = createAudit(sink);
    for (const bad of [
      { ...ENTRY, laneId: "pkg" },
      { ...ENTRY, action: "NotDotted" },
      { ...ENTRY, actor: { kind: "user", userId: "not-a-uuid" } },
      { ...ENTRY, target: "x".repeat(301) },
      { ...ENTRY, extra: true },
    ]) {
      await expect(audit.log(bad as never)).rejects.toMatchObject({ name: "AuditError", reason: "invalid_entry" });
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it("rejects a secret-looking or free-text target", async () => {
    const audit = createAudit(vi.fn<AuditSink>(async () => {}));
    await expect(audit.log({ ...ENTRY, target: "sk_live_target" })).rejects.toMatchObject({ reason: "invalid_entry" });
    await expect(audit.log({ ...ENTRY, target: "free text" })).rejects.toMatchObject({ reason: "invalid_entry" });
  });

  it("a throwing getter becomes AuditError without its message", async () => {
    const metadata = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter leaked sk_live_x");
      },
    }) as Record<string, unknown>;
    const err = await createAudit(vi.fn<AuditSink>(async () => {})).log({ ...ENTRY, metadata }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "AuditError", reason: "invalid_entry" });
    expect(String(err)).not.toContain("sk_live");
  });

  it("turns a sink failure into AuditError without the database message", async () => {
    const audit = createAudit(async () => {
      throw new Error('new row violates check constraint; Failing row contains (PKG, {"note": "private data"})');
    });
    const err = await audit.log(ENTRY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).reason).toBe("write_failed");
    expect(JSON.stringify(err) + String(err) + String((err as Error).cause)).not.toContain("private data");
  });
});

describe("withAudit", () => {
  const recording = () => {
    const actions: string[] = [];
    const audit = createAudit(async (row) => {
      actions.push(row.p_action);
    });
    return { audit, actions };
  };

  it("records requested, runs the action, then records succeeded", async () => {
    const { audit, actions } = recording();
    const result = await withAudit(audit, ENTRY, async () => {
      actions.push("ACTION");
      return 42;
    });
    expect(result).toBe(42);
    expect(actions).toEqual(["lane_config.version_created.requested", "ACTION", "lane_config.version_created.succeeded"]);
  });

  it("records failed (error class only) and rethrows when the action throws", async () => {
    const rows: AuditRow[] = [];
    const audit = createAudit(async (row) => {
      rows.push(row);
    });
    class ProviderDown extends Error {
      override name = "ProviderDown";
    }
    await expect(withAudit(audit, ENTRY, async () => Promise.reject(new ProviderDown("token sk_live_x in message")))).rejects.toBeInstanceOf(ProviderDown);
    expect(rows.map((r) => r.p_action)).toEqual(["lane_config.version_created.requested", "lane_config.version_created.failed"]);
    expect(rows[1]?.p_metadata).toEqual({ error_class: "ProviderDown" });
  });

  it("does not run the action when the first audit write fails", async () => {
    const action = vi.fn(async () => 1);
    const audit = createAudit(async () => {
      throw new Error("db down");
    });
    await expect(withAudit(audit, ENTRY, action)).rejects.toBeInstanceOf(AuditError);
    expect(action).not.toHaveBeenCalled();
  });

  it("fails the caller when the outcome cannot be recorded", async () => {
    let calls = 0;
    const audit = createAudit(async () => {
      calls += 1;
      if (calls === 2) throw new Error("db down");
    });
    await expect(withAudit(audit, ENTRY, async () => 1)).rejects.toBeInstanceOf(AuditError);
  });
});
