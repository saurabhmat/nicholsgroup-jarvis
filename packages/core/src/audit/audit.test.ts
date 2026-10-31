import { describe, expect, it, vi } from "vitest";
import { AuditError, createAudit, isSensitiveKey, REDACTED, redactMetadata, withAudit, type AuditSink } from "./index";

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
    const out = redactMetadata({ ref: "sk_live_abc", list: ["  sb_secret_x", "fine"], jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" });
    expect(out).toEqual({ ref: REDACTED, list: [REDACTED, "fine"], jwt: REDACTED });
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
  it("audits first, then runs the action", async () => {
    const order: string[] = [];
    const audit = createAudit(async () => {
      order.push("audit");
    });
    const result = await withAudit(audit, ENTRY, async () => {
      order.push("action");
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(["audit", "action"]);
  });

  it("does not run the action when the audit write fails", async () => {
    const action = vi.fn(async () => 1);
    const audit = createAudit(async () => {
      throw new Error("db down");
    });
    await expect(withAudit(audit, ENTRY, action)).rejects.toBeInstanceOf(AuditError);
    expect(action).not.toHaveBeenCalled();
  });
});
