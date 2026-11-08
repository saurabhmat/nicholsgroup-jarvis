import { describe, expect, it } from "vitest";
import { asOfLabel, buildMessages, createSseParser, groupCitations, isInAppPath, type ClientTurn } from "./assistant-client";

const u = (text: string): ClientTurn => ({ role: "user", text });
const a = (text: string, error?: string): ClientTurn => ({ role: "assistant", text, ...(error ? { error } : {}) });

describe("buildMessages", () => {
  it("keeps every answer with its own question after a failed or stopped answer", () => {
    const turns = [u("Q0"), a("A0"), u("Q1"), a("partial", "Stopped."), u("Q2"), a("A2")];
    expect(buildMessages(turns, "Q3")).toEqual([u("Q0"), a("A0"), u("Q2"), a("A2"), u("Q3")]);
  });
  it("drops empty and whitespace-only answers as a pair", () => {
    expect(buildMessages([u("Q0"), a("  "), u("Q1"), a("")], "Q2")).toEqual([u("Q2")]);
  });
  it("stays within the turn and size caps, dropping the oldest pairs", () => {
    const many = Array.from({ length: 30 }, (_, i) => [u(`Q${i}`), a(`A${i}`)]).flat();
    const out = buildMessages(many, "now");
    expect(out.length).toBeLessThanOrEqual(19);
    expect(out[0]?.role).toBe("user");
    expect(out.at(-1)).toEqual(u("now"));
    const big = Array.from({ length: 8 }, (_, i) => [u("x".repeat(3000)), a(`A${i}`)]).flat();
    expect(buildMessages(big, "q").reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(20_000);
  });
});

describe("createSseParser", () => {
  it("handles split chunks, skips malformed frames and flushes a trailing frame", () => {
    const p = createSseParser();
    expect(p.push('event: a\ndata: {"type":"message.st')).toEqual([]);
    expect(p.push('art"}\n\nevent: x\ndata: {bad json}\n\nevent: t\ndata: {"type":"text.delta","text":"é"}\n\n')).toEqual([
      { type: "message.start" },
      { type: "text.delta", text: "é" },
    ]);
    expect(p.push('data: {"type":"message.done"}')).toEqual([]);
    expect(p.end()).toEqual([{ type: "message.done" }]);
  });
});

describe("groupCitations", () => {
  it("shows three per kind then one +N chip to the kind's page", () => {
    const mail = Array.from({ length: 6 }, (_, i) => ({ kind: "email", label: `S${i}`, url: `/PKG/inbox/m${i}`, asOf: "", freshness: "cached" as const }));
    const out = groupCitations([...mail, { kind: "calendar", label: "Calendar", url: "/PKG/calendar", asOf: "", freshness: "cached" }]);
    expect(out.map((c) => c.label)).toEqual(["S0", "S1", "S2", "+3 more", "Calendar"]);
    expect(out[3]?.url).toBe("/PKG/inbox");
  });
});

describe("helpers", () => {
  it("formats as-of with a date when not today", () => {
    const now = new Date("2026-11-10T15:00:00Z");
    expect(asOfLabel("2026-11-10T14:05:00Z", now)).toBe("9:05 AM");
    expect(asOfLabel("2026-11-09T14:05:00Z", now)).toBe("Nov 9");
  });
  it("accepts in-app paths only", () => {
    expect(isInAppPath("/PKG/inbox/m_1")).toBe(true);
    for (const bad of ["//evil.example", "javascript:alert(1)", "https://x", "/\\evil", "/..%2f", null]) expect(isInAppPath(bad)).toBe(false);
  });
});
