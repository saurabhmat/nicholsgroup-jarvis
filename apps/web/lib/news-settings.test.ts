import { describe, expect, it } from "vitest";
import { newsSectionFor } from "./news-settings";

const guardsFor = (rows: unknown, error: unknown = null, roleError = false) => {
  const asked: unknown[] = [];
  return {
    asked,
    g: {
      requireRole: async (_lane: string, roles: string[]) => {
        asked.push(roles);
        if (roleError) throw new Error("forbidden");
        return { client: { schema: () => ({ rpc: async () => ({ data: rows, error }) }) } };
      },
    } as never,
  };
};

describe("newsSectionFor", () => {
  it("asks only for owner / admin_technical and maps the row", async () => {
    const { g, asked } = guardsFor([{ web_allowed: true, news_enabled: true, cap_usd: "20", month_spend: "1.50", month_fetches: 2, last_status: "failed", last_failure_code: "timed_out", last_fetch_at: "2026-11-12T11:00:00Z" }]);
    expect(await newsSectionFor(g, "PKG")).toEqual({ webAllowed: true, enabled: true, capUsd: 20, monthSpendUsd: 1.5, monthFetches: 2, lastStatus: "failed", lastFailure: "the fetch took too long", lastFetchAt: "2026-11-12T11:00:00Z" });
    expect(asked).toEqual([["owner", "admin_technical"]]);
  });
  it("any other role, an error or no row: null (the section is not drawn)", async () => {
    expect(await newsSectionFor(guardsFor([], null, true).g, "PKG")).toBeNull();
    expect(await newsSectionFor(guardsFor(null, { message: "x" }).g, "PKG")).toBeNull();
    expect(await newsSectionFor(guardsFor([]).g, "PKG")).toBeNull();
  });
});
