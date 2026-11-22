// T-265 audit: the scheduled readers of apps/web over a mail-only lane config (no finance, news, briefing schedule or approvals keys).
// With the schedules off by default, a mail-only lane gets no scheduled briefing, no refresh after mail and no news fetch: no model
// call, no spend, no error. Synthetic.
import { describe, expect, it, vi } from "vitest";

vi.mock("@nichols/ai/config", () => ({ getLLMProvider: () => ({ configured: false }) }));
const { dueOwners, refreshOwners } = await import("@/lib/briefing-schedule");
const { newsDue } = await import("@/lib/news-schedule");

const MAIL_ONLY = {
  enabled_modules: ["comms", "calendar", "briefing"],
  limit_to_enabled_modules: true,
  mail: { providers: ["microsoft"], allowed_domains: ["mail-only.example.test"] },
  microsoft: { cloud: "commercial", tenant_ids: ["11111111-2222-4333-8444-555555555555"] },
};
const clientFor = (config: unknown) => async () =>
  ({ schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: config === undefined ? null : { config }, error: null }) }) }) }) }) }) as never;

describe("scheduled readers over a mail-only lane (T-265)", () => {
  it("nobody is due for a scheduled briefing or an automatic refresh, and no news fetch is due", async () => {
    const noon = new Date("2026-11-23T14:00:00Z");
    expect(await dueOwners(clientFor(MAIL_ONLY), "XX", noon)).toEqual([]);
    expect(await refreshOwners(clientFor(MAIL_ONLY), "XX")).toEqual([]);
    expect(await newsDue(clientFor(MAIL_ONLY), "XX", noon)).toBe(false);
  });
  it("the same holds for a lane with no config row yet", async () => {
    const noon = new Date("2026-11-23T14:00:00Z");
    expect(await dueOwners(clientFor(undefined), "XX", noon)).toEqual([]);
    expect(await refreshOwners(clientFor(undefined), "XX")).toEqual([]);
    expect(await newsDue(clientFor(undefined), "XX", noon)).toBe(false);
  });
});
