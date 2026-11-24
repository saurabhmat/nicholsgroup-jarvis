// T-278: the `teams` block of lane_config (docs/specs/messages.md 4.3) and the `messages` module. Synthetic tenant ids and example.test domains only.
import { describe, expect, it } from "vitest";
import { MODULES, moduleVisible, NON_ORGANIZATION_TENANT_IDS, parseLaneConfig, TEAMS_FEATURES, teamsSchema, teamsViewSchema } from "./index";

const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const OK = { enabled: true, tenant_ids: [T1], allowed_domains: ["teams.example.test"] };

describe("teams block", () => {
  it("is optional: a config without it parses, and the lane has no Teams", () => {
    expect(parseLaneConfig({}).teams).toBeUndefined();
  });

  it("applies the defaults: enabled false, commercial cloud, features [chat_read]", () => {
    const t = teamsSchema.parse({ tenant_ids: [T1], allowed_domains: ["teams.example.test"] });
    expect(t).toEqual({ enabled: false, cloud: "commercial", tenant_ids: [T1], allowed_domains: ["teams.example.test"], features: ["chat_read"] });
  });

  it("accepts a full valid block, independent of mail.providers and of a microsoft block", () => {
    const c = parseLaneConfig({ mail: { providers: ["google"] }, teams: { ...OK, cloud: "commercial", features: ["chat_read", "call_links"] } });
    expect(c.teams).toMatchObject({ enabled: true, tenant_ids: [T1], features: ["chat_read", "call_links"] });
    expect(c.microsoft).toBeUndefined();
    // a lane with Microsoft mail and Teams, and a lane with neither mail provider's block but Teams
    expect(parseLaneConfig({ mail: { providers: ["microsoft"] }, microsoft: { tenant_ids: [T1] }, teams: OK }).teams?.enabled).toBe(true);
  });

  it("is strict: an unknown key is refused (a typo must not read as the default)", () => {
    expect(() => parseLaneConfig({ teams: { ...OK, Features: ["chat_read"] } })).toThrow();
    expect(() => parseLaneConfig({ teams: { ...OK, tenant_id: T1 } })).toThrow();
    expect(() => parseLaneConfig({ teams: { ...OK, mail_folders: ["inbox"] } })).toThrow();
  });

  it("tenant_ids: 1 to 10, lower-case UUIDs, unique, never the personal-account or nil tenant", () => {
    const bad = (tenant_ids: unknown) => teamsSchema.safeParse({ ...OK, tenant_ids }).success;
    expect(bad([])).toBe(false);
    expect(bad(Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`))).toBe(false);
    expect(bad(Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`))).toBe(true);
    expect(bad([T1.toUpperCase().replace(/[0-9]/g, "A")])).toBe(false);
    expect(bad(["AAAAAAAA-2222-4333-8444-555555555555"])).toBe(false);
    expect(bad([T1, T1])).toBe(false);
    expect(bad([T1, T2])).toBe(true);
    for (const id of NON_ORGANIZATION_TENANT_IDS) expect(bad([id]), id).toBe(false);
    expect(bad(["not-a-uuid"])).toBe(false);
    expect(bad(undefined)).toBe(false);
  });

  it("allowed_domains: 1 to 20, lower-case DNS names with at least two labels, unique; empty refuses (fail closed)", () => {
    const ok = (allowed_domains: unknown) => teamsSchema.safeParse({ ...OK, allowed_domains }).success;
    expect(ok([])).toBe(false);
    expect(ok(["a.example.test", "b.example.test"])).toBe(true);
    expect(ok(["A.example.test"])).toBe(false);
    expect(ok(["localhost"])).toBe(false);
    expect(ok(["*.example.test"])).toBe(false);
    expect(ok(["https://example.test"])).toBe(false);
    expect(ok(["a.example.test", "a.example.test"])).toBe(false);
    expect(ok(Array.from({ length: 21 }, (_, i) => `d${String(i)}.example.test`))).toBe(false);
    expect(ok(Array.from({ length: 20 }, (_, i) => `d${String(i)}.example.test`))).toBe(true);
    expect(teamsSchema.safeParse({ tenant_ids: [T1] }).success).toBe(false);
  });

  it("features: the five names, unique, at least one; chat_send needs chat_read and channels_send needs channels_read", () => {
    expect([...TEAMS_FEATURES]).toEqual(["chat_read", "chat_send", "call_links", "channels_read", "channels_send"]);
    const ok = (features: unknown) => teamsSchema.safeParse({ ...OK, features }).success;
    expect(ok(["chat_read"])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok(["chat_read", "chat_read"])).toBe(false);
    expect(ok(["chat_send"])).toBe(false);
    expect(ok(["chat_read", "chat_send"])).toBe(true);
    expect(ok(["channels_send"])).toBe(false);
    expect(ok(["chat_read", "channels_send"])).toBe(false);
    expect(ok(["channels_read", "channels_send"])).toBe(true);
    expect(ok(["chat_read", "chat_send", "call_links", "channels_read", "channels_send"])).toBe(true);
    expect(ok(["calls"])).toBe(false);
    expect(ok(["chat_read", "presence"])).toBe(false);
  });

  it("cloud: commercial or gcc_high (storable; the guard refuses gcc_high until a GCC High Teams task); anything else refuses", () => {
    expect(teamsSchema.safeParse({ ...OK, cloud: "gcc_high" }).success).toBe(true);
    expect(teamsSchema.safeParse({ ...OK, cloud: "dod" }).success).toBe(false);
    expect(teamsSchema.safeParse({ ...OK, enabled: "yes" }).success).toBe(false);
  });

  it("the narrow view reads only `teams` and ignores every other root key (a bad mail setting does not hide Teams)", () => {
    expect(teamsViewSchema.parse({ teams: OK, mail: { providers: ["nope"] }, anything: 1 }).teams?.enabled).toBe(true);
    expect(teamsViewSchema.parse({}).teams).toBeUndefined();
    expect(teamsViewSchema.safeParse({ teams: { ...OK, tenant_ids: [] } }).success).toBe(false);
  });
});

describe("messages module", () => {
  it("is a module: an unlimited lane shows it, a limited lane only when it lists it", () => {
    expect(MODULES).toContain("messages");
    expect(moduleVisible({}, "messages")).toBe(true);
    expect(moduleVisible({ limit_to_enabled_modules: true, enabled_modules: ["comms", "calendar"] }, "messages")).toBe(false);
    expect(moduleVisible({ limit_to_enabled_modules: true, enabled_modules: ["comms", "messages"] }, "messages")).toBe(true);
    expect(parseLaneConfig({ limit_to_enabled_modules: true, enabled_modules: ["messages"] }).enabled_modules).toEqual(["messages"]);
  });
});
