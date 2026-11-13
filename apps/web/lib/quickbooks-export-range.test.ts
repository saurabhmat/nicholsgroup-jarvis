import { describe, expect, it } from "vitest";
import { checkExportRange, defaultExportRange, etDay } from "./quickbooks-export-range";

describe("export range", () => {
  it("the default is the last 30 days ending today in New York (30 days inclusive)", () => {
    expect(defaultExportRange(new Date("2026-11-13T15:00:00Z"))).toEqual({ from: "2026-10-15", to: "2026-11-13" });
    // 02:00 UTC on Nov 14 is still Nov 13 evening in New York.
    expect(etDay(new Date("2026-11-14T02:00:00Z"))).toBe("2026-11-13");
    expect(defaultExportRange(new Date("2026-11-14T02:00:00Z")).to).toBe("2026-11-13");
  });
  it("accepts 90 days inclusive, refuses 91, backwards and junk", () => {
    expect(checkExportRange("2026-08-16", "2026-11-13").ok).toBe(true);
    expect(checkExportRange("2026-08-15", "2026-11-13")).toMatchObject({ ok: false });
    expect(checkExportRange("2026-11-13", "2026-11-12")).toMatchObject({ ok: false });
    expect(checkExportRange("", "2026-11-12")).toMatchObject({ ok: false });
    expect(checkExportRange("2026-02-30", "2026-03-02")).toMatchObject({ ok: false });
    expect(checkExportRange("2026-11-13", "2026-11-13").ok).toBe(true);
  });
  it("matches the connectors' route limit", async () => {
    const { EXPORT_MAX_DAYS } = await import("@nichols/connectors/error-log");
    expect((await import("./quickbooks-export-range")).EXPORT_MAX_DAYS).toBe(EXPORT_MAX_DAYS);
  });
});
