// T-226: which Composio settings are not set, as NAMES only (the Settings row says "Not configured: X is not set").
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
const CANARY = "composio-canary-value-9b7c2d41";

describe("composioMissingSettings", () => {
  it("project key present, Gmail id missing: only the Gmail id name; the calendar id is set", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", CANARY);
    vi.stubEnv("COMPOSIO_GMAIL_AUTH_CONFIG_ID", "");
    vi.stubEnv("COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID", "ac_calendar_synthetic");
    const { composioMissingSettings } = await import("./index");
    const r = composioMissingSettings();
    expect(r).toEqual({ gmail: ["COMPOSIO_GMAIL_AUTH_CONFIG_ID"], googlecalendar: [] });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain("ac_calendar_synthetic");
  });

  it("no project key: the key name for every toolkit, never a value", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "");
    vi.stubEnv("COMPOSIO_GMAIL_AUTH_CONFIG_ID", CANARY);
    vi.stubEnv("COMPOSIO_GOOGLECALENDAR_AUTH_CONFIG_ID", CANARY);
    const { composioMissingSettings } = await import("./index");
    const r = composioMissingSettings();
    expect(r).toEqual({ gmail: ["COMPOSIO_API_KEY"], googlecalendar: ["COMPOSIO_API_KEY"] });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});
