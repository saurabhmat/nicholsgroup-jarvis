// T-056: facts the SQL normalizer depends on that live in TypeScript (kept in step by this test).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QBO_PAYROLL_SUBTYPES } from "@nichols/core/lane-config";

const MIGRATION = readFileSync(new URL("../../../../supabase/core/supabase/migrations/20261106100000_fin_qbo_normalizer.sql", import.meta.url), "utf8");

describe("fin_qbo_normalize migration", () => {
  it("defaults the payroll subtypes to the connector's list (lower-cased)", () => {
    const m = /array\[('payroll[^\]]*)\] end;/.exec(MIGRATION);
    expect(m).not.toBeNull();
    const sql = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(sql).toEqual(QBO_PAYROLL_SUBTYPES.map((s) => s.toLowerCase()));
  });

  it("uses the same payroll name safety net as the connector", () => {
    expect(MIGRATION).toContain("(payroll|salar(y|ies)|\\ywages?\\y|compensation)");
  });

  it("scans the same reference keys as the connector's exclusion scan", () => {
    expect(MIGRATION).toContain("e.key ~* 'AccountRef$'");
    expect(MIGRATION).toContain("e.key ~ '^(Entity|Vendor|Customer)Ref$'");
  });

  it("is service_role only and pins an empty search_path", () => {
    expect(MIGRATION).toMatch(/revoke all on function core\.fin_qbo_normalize\(text, uuid\) from public, anon, authenticated;/);
    expect(MIGRATION).toMatch(/grant execute on function core\.fin_qbo_normalize\(text, uuid\) to service_role;/);
    expect(MIGRATION).toMatch(/security definer\nset search_path = ''/);
  });
});

describe("Purchase.Credit projection", () => {
  it("keeps the boolean Credit flag (the normalizer flips posting signs on it) and nothing else of the kind", async () => {
    const { projectEntity } = await import("./entities");
    const p = projectEntity("Purchase", { Id: "7", TotalAmt: 40, Credit: true, PrivateNote: "memo SECRET", AccountRef: { value: "10" } });
    expect(p?.payload).toMatchObject({ Id: "7", Credit: true });
    expect(JSON.stringify(p?.payload)).not.toContain("SECRET");
    expect(projectEntity("Purchase", { Id: "8", Credit: "yes" })).toBeNull();
    expect(projectEntity("Purchase", { Id: "9" })?.payload).not.toHaveProperty("Credit");
  });
});
