// The provider gate on its own (T-255 review): the branches the real lane-config reader cannot produce are driven with a stub reader.
import { describe, expect, it, vi } from "vitest";
import { ConnectorError } from "../contract/errors";
import type { LaneConfigReader } from "../vault/lane-config";

type MailProviderSettings = Awaited<ReturnType<LaneConfigReader["mailProviderSettings"]>>;
import { PROVIDER_DISABLED_MESSAGE, createProviderGate, isProviderDisabledError } from "./gate";

const BLOCK = { cloud: "commercial" as const, tenantIds: ["00000000-0000-4000-8000-00000000aa01"], allowGcc: false, mailFolders: ["inbox" as const], calendarIds: null };
function gateOf(settings: unknown) {
  const mailProviderSettings = vi.fn(async () => settings as MailProviderSettings);
  return { mailProviderSettings, gate: createProviderGate({ laneConfig: { mailProviderSettings } }) };
}

describe("provider gate", () => {
  it("microsoft listed but no microsoft block: Microsoft is not enabled, Google is (the reader refuses this shape; the gate does not rely on that)", async () => {
    const { gate } = gateOf({ providers: ["google", "microsoft"], microsoft: null });
    expect(await gate.enabled("PKG", "microsoft")).toBe(false);
    expect(await gate.enabled("PKG", "google")).toBe(true);
    const e = await gate.assertEnabled("PKG", "microsoft").catch((x: unknown) => x);
    expect(isProviderDisabledError(e)).toBe(true);
    expect((e as ConnectorError).info).toMatchObject({ kind: "connection_unavailable", message: PROVIDER_DISABLED_MESSAGE });
  });
  it("microsoft block present but microsoft not listed (Microsoft paused): not enabled", async () => {
    const { gate } = gateOf({ providers: ["google"], microsoft: BLOCK });
    expect(await gate.enabled("PKG", "microsoft")).toBe(false);
    expect(await gate.enabled("PKG", "google")).toBe(true);
  });
  it("google not listed (Google paused): not enabled, Microsoft with its block is", async () => {
    const { gate } = gateOf({ providers: ["microsoft"], microsoft: BLOCK });
    expect(await gate.enabled("PKG", "google")).toBe(false);
    expect(await gate.enabled("PKG", "microsoft")).toBe(true);
  });
  it("one config read per decision, for the lane asked; a provider that is not mail/calendar needs no read", async () => {
    const { gate, mailProviderSettings } = gateOf({ providers: ["google"], microsoft: null });
    expect(await gate.enabled("PKG", "quickbooks")).toBe(true);
    expect(mailProviderSettings).not.toHaveBeenCalled();
    await gate.enabled("PKG", "google");
    await gate.assertEnabled("PKG", "google");
    expect(mailProviderSettings.mock.calls).toEqual([["PKG"], ["PKG"]]);
  });
  it("a failed config read is thrown on, never read as enabled or as disabled", async () => {
    const boom = new ConnectorError({ kind: "provider_error", message: "Lane configuration is not valid" });
    const gate = createProviderGate({ laneConfig: { mailProviderSettings: async () => Promise.reject(boom) } });
    expect(await gate.enabled("PKG", "google").catch((x: unknown) => x)).toBe(boom);
    const e = await gate.assertEnabled("PKG", "microsoft").catch((x: unknown) => x);
    expect(e).toBe(boom);
    expect(isProviderDisabledError(e)).toBe(false);
  });
});
