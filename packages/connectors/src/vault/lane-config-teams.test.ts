// T-278: `teamsSettings(laneId)` of the lane config reader (docs/specs/messages.md 4.3): independent of the mail providers, defaults applied, null when the lane has no block, and
// fail closed (a throw) when the config is unreadable or the block is malformed. A fake job client stands in for the database.
import { describe, expect, it } from "vitest";
import { createLaneConfigReader } from "./lane-config";

const T1 = "11111111-2222-4333-8444-555555555555";
const reader = (config: unknown, error: unknown = null) => {
  const query = { eq: () => ({ maybeSingle: async () => ({ data: config === undefined ? null : { config }, error }) }) };
  const client = { schema: () => ({ from: () => ({ select: () => query }) }) };
  return createLaneConfigReader((async () => client) as never);
};

describe("teamsSettings", () => {
  it("returns the block with defaults applied", async () => {
    const s = await reader({ teams: { enabled: true, tenant_ids: [T1], allowed_domains: ["teams.example.test"] } }).teamsSettings("PKG");
    expect(s).toEqual({ enabled: true, cloud: "commercial", tenantIds: [T1], allowedDomains: ["teams.example.test"], features: ["chat_read"] });
  });

  it("is null when the lane has no block, no config row, or a null config (Teams is not set up)", async () => {
    expect(await reader({ mail: { providers: ["google"] } }).teamsSettings("PKG")).toBeNull();
    expect(await reader(undefined).teamsSettings("PKG")).toBeNull();
    expect(await reader(null).teamsSettings("PKG")).toBeNull();
  });

  it("does not depend on the mail settings: a Google-mail lane, a Microsoft-mail lane and a lane with a malformed mail section all read their Teams block", async () => {
    const teams = { enabled: true, tenant_ids: [T1], allowed_domains: ["teams.example.test"], features: ["chat_read", "chat_send"] };
    for (const extra of [{ mail: { providers: ["google"] } }, { mail: { providers: ["microsoft"] }, microsoft: { tenant_ids: [T1] } }, { mail: { providers: ["nope"] } }]) {
      expect((await reader({ ...extra, teams }).teamsSettings("PKG"))?.features).toEqual(["chat_read", "chat_send"]);
    }
  });

  it("fails closed: a malformed block (empty tenants, an unknown feature, a typo'd key) and an unreadable config throw; they never read as null or as enabled", async () => {
    for (const teams of [{ enabled: true, tenant_ids: [], allowed_domains: ["a.example.test"] }, { enabled: true, tenant_ids: [T1], allowed_domains: ["a.example.test"], features: ["calls"] }, { enabled: true, tenant_ids: [T1], allowed_domains: ["a.example.test"], Enabled: true }, "yes", 5]) {
      await expect(reader({ teams }).teamsSettings("PKG"), JSON.stringify(teams)).rejects.toMatchObject({ info: { kind: "provider_error" } });
    }
    await expect(reader({}, { message: "boom" }).teamsSettings("PKG")).rejects.toMatchObject({ info: { kind: "transient" } });
    await expect(reader({}).teamsSettings("pkg" as never)).rejects.toMatchObject({ info: { kind: "invalid_input" } });
  });
});
